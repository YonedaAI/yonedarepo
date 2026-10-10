use crate::{
    agent_transcript::Transcript,
    broker::broker,
    err, field,
    process::{captured_output_with_input, untrusted},
    workspace::export_with_baseline,
};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use yoneda_core::Result;
pub(crate) async fn execute(job: &Value, root: &Path, transcript: &Transcript) -> Result<Value> {
    let approved_budget = crate::execution_limits::model_budget(job)?;
    let git_native = crate::transport::enabled(job);
    let baseline = if git_native {
        crate::transport::prepare_agent_workspace(job, root).await?;
        yoneda_core::Workspace::new()
    } else {
        super::jobs::workspace(job, root).await?
    };
    let git_baseline = if git_native && job["payload"]["team_planning"] == true {
        Some(crate::transport::snapshot_read_only(root).await?)
    } else {
        None
    };
    #[cfg(target_os = "linux")]
    {
        Command::new("/usr/bin/chown")
            .args(["-R", "1000:1000", "/work", "/home/agent"])
            .status()
            .await
            .map_err(err)?;
    }
    let payload = &job["payload"];
    let execution = &payload["execution"];
    let model = field(job, "model")?;
    let mut prompt = crate::prompt::prompt(payload)?;
    if git_native {
        prompt.push_str("\n\nWorkspace transport: git-native-v1. Commit your completed changes on branch main and push them to origin. Preserve the existing history and do not modify remote URLs or credentials.\n");
    }
    let mcp = json!({"mcpServers":{"yonedarepo":{"command":"/usr/local/bin/yoneda-runtime","args":["mcp"]}}});
    std::fs::write("/home/agent/mcp.json", mcp.to_string()).map_err(err)?;
    std::fs::create_dir_all("/home/agent/.codex").map_err(err)?;
    let config = format!(
        "model = {model:?}\nmodel_provider = \"yoneda\"\nmodel_reasoning_effort = \"low\"\n[model_providers.yoneda]\nname = \"Yoneda scoped proxy\"\nbase_url = \"http://codex.yoneda.internal/v1\"\nwire_api = \"responses\"\n[mcp_servers.yonedarepo]\ncommand = \"/usr/local/bin/yoneda-runtime\"\nargs = [\"mcp\"]\n"
    );
    std::fs::write("/home/agent/.codex/config.toml", config).map_err(err)?;
    #[cfg(target_os = "linux")]
    {
        Command::new("/usr/bin/chown")
            .args(["-R", "1000:1000", "/home/agent"])
            .status()
            .await
            .map_err(err)?;
    }
    let harness = field(execution, "harness")?;
    if !["codex", "claude", "gemini"].contains(&harness) {
        return Err(err("Unsupported agent harness"));
    }
    if harness == "gemini" {
        // System settings override repository settings. Only the scoped MCP is trusted.
        std::fs::create_dir_all("/etc/gemini-cli").map_err(err)?;
        let settings = gemini_settings(model, &mcp, approved_budget.as_ref());
        std::fs::write("/etc/gemini-cli/settings.json", settings.to_string()).map_err(err)?;
    }
    let mut command = Command::new(harness);
    untrusted(&mut command, root);
    configure_output_limit(&mut command, approved_budget.as_ref());
    if execution["harness"] == "codex" {
        command.args([
            "exec",
            "--ephemeral",
            "--json",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--model",
            model,
            "-",
        ]);
    } else if harness == "gemini" {
        command
            .env("GEMINI_API_KEY", "scoped-container-proxy")
            .env("GOOGLE_GEMINI_BASE_URL", "https://gemini.yoneda.internal")
            .env("GOOGLE_GENAI_API_VERSION", "v1beta")
            .env("GEMINI_TELEMETRY_ENABLED", "false")
            .env("GEMINI_CLI_TRUST_WORKSPACE", "true")
            .args([
                "--prompt",
                "",
                "--model",
                model,
                "--output-format",
                "stream-json",
                "--approval-mode",
                "yolo",
            ]);
    } else {
        for name in [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        ] {
            command.env(name, model);
        }
        command.args(claude_arguments(
            execution,
            approved_budget.is_some(),
            model,
        ));
    }
    broker(
        "/progress",
        json!({"progress":{"stage":"harness_running"}}),
        true,
    )
    .await?;
    let output = captured_output_with_input(&mut command, transcript, Some(&prompt)).await?;
    let evidence = broker("/evidence", json!({"content":output.to_string()}), true).await?;
    transcript.mark_recorded()?;
    if output["exit"] != 0 {
        return Err(crate::harness_error::failure(&output, &evidence));
    }
    if execution["role"] == "research" {
        return Ok(json!({"transcript":evidence["digest"],"model":model}));
    }
    if git_native {
        let commit = crate::git::git(root, &["rev-parse", "HEAD"]).await?;
        if let Some(snapshot) = &git_baseline {
            crate::transport::verify_read_only(root, snapshot).await?;
            return Ok(git_agent_result(
                job,
                commit,
                true,
                &evidence["digest"],
                model,
            ));
        }
        return Ok(git_agent_result(
            job,
            commit,
            false,
            &evidence["digest"],
            model,
        ));
    }
    let files = export_with_baseline(root, &baseline)?;
    if payload["team_planning"] == true {
        crate::team_workspace::validate_read_only(&baseline, &files)?;
        return Ok(
            json!({"planning":true,"source_unchanged":true,"transcript":evidence["digest"],"model":model}),
        );
    }
    if let Some(scope) = payload.get("team_owned_paths") {
        crate::team_workspace::validate_changes(&baseline, &files, scope)?;
    }
    let uploaded = broker("/workspace", json!({"files":files}), true).await?;
    Ok(json!({"workspace":uploaded["digest"],"transcript":evidence["digest"],"model":model}))
}

fn git_agent_result(
    job: &Value,
    commit: String,
    planning: bool,
    transcript: &Value,
    model: &str,
) -> Value {
    let mut result = json!({
        "fork_revision":crate::transport::candidate_revision(job, commit),
        "transcript":transcript,
        "model":model
    });
    if planning {
        result["planning"] = json!(true);
        result["source_unchanged"] = json!(true);
    }
    result
}

fn gemini_settings(
    model: &str,
    mcp: &Value,
    budget: Option<&yoneda_core::model_budget::ModelBudget>,
) -> Value {
    let turns = budget.map_or(24, |budget| budget.max_requests.unwrap_or(-1));
    json!({"security":{"auth":{"selectedType":"gemini-api-key","enforcedType":"gemini-api-key"}},
        "model":{"name":model,"maxSessionTurns":turns},"telemetry":{"enabled":false},
        "privacy":{"usageStatisticsEnabled":false},"mcp":{"allowed":["yonedarepo"]},
        "mcpServers":mcp["mcpServers"],"tools":{"exclude":["google_web_search","web_fetch"]}})
}

fn configure_output_limit(
    command: &mut Command,
    budget: Option<&yoneda_core::model_budget::ModelBudget>,
) {
    if let Some(budget) = budget {
        command.env(
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            budget.max_output_tokens.to_string(),
        );
    }
}

fn claude_arguments<'a>(execution: &Value, approved_budget: bool, model: &'a str) -> Vec<&'a str> {
    let mut args = vec![
        "-p",
        "--input-format",
        "text",
        "--model",
        model,
        "--output-format",
        "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--mcp-config",
        "/home/agent/mcp.json",
        "--setting-sources",
        "",
        "--dangerously-skip-permissions",
    ];
    // Claude Code's dollar estimate uses Anthropic pricing. Third-party models
    // retain the authoritative request/time/output limits in the scoped proxy.
    if !approved_budget
        && (execution["provider"] == "claude"
            || (execution.get("provider").is_none() && execution["harness"] == "claude"))
    {
        args.extend(["--max-budget-usd", "1.00"]);
    }
    args
}

#[cfg(test)]
#[path = "tests/agent_config.rs"]
mod tests;
