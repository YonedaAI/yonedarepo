//! Shared scoped harness invocation; callers own coding versus read-only completion.
use crate::{
    agent_transcript::Transcript,
    broker::broker,
    err, field,
    process::{captured_output_with_input, untrusted},
};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use yoneda_core::{Result, model_budget::ModelBudget};

pub(crate) async fn run(
    job: &Value,
    root: &Path,
    transcript: &Transcript,
    prompt: &str,
    approved_budget: Option<&ModelBudget>,
) -> Result<Value> {
    let execution = &job["payload"]["execution"];
    let model = field(job, "model")?;
    let mcp = json!({"mcpServers":{"yonedarepo":{"command":"/usr/local/bin/yoneda-runtime","args":["mcp"]}}});
    std::fs::write("/home/agent/mcp.json", mcp.to_string()).map_err(err)?;
    std::fs::create_dir_all("/home/agent/.codex").map_err(err)?;
    let config = codex_configuration(model, execution);
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
        let settings = gemini_settings(model, &mcp, approved_budget);
        std::fs::write("/etc/gemini-cli/settings.json", settings.to_string()).map_err(err)?;
    }
    let mut command = Command::new(harness);
    untrusted(&mut command, root);
    if job["payload"]["review_only"] == true {
        command.env("YONEDA_COMPARISON_REVIEW", "1");
    }
    configure_output_limit(&mut command, approved_budget);
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
    let output = captured_output_with_input(&mut command, transcript, Some(prompt)).await?;
    let evidence = broker("/evidence", json!({"content":output.to_string()}), true).await?;
    transcript.mark_recorded()?;
    if output["exit"] != 0 {
        return Err(crate::harness_error::failure(&output, &evidence));
    }
    Ok(evidence)
}

pub(crate) fn codex_configuration(model: &str, execution: &Value) -> String {
    let effort = execution["reasoning_effort"].as_str().unwrap_or("low");
    format!(
        "model = {model:?}\nmodel_provider = \"yoneda\"\nmodel_reasoning_effort = {effort:?}\n[model_providers.yoneda]\nname = \"Yoneda scoped proxy\"\nbase_url = \"http://codex.yoneda.internal/v1\"\nwire_api = \"responses\"\n[mcp_servers.yonedarepo]\ncommand = \"/usr/local/bin/yoneda-runtime\"\nargs = [\"mcp\"]\n"
    )
}

pub(crate) fn gemini_settings(
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

pub(crate) fn configure_output_limit(
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

pub(crate) fn claude_arguments<'a>(
    execution: &Value,
    approved_budget: bool,
    model: &'a str,
) -> Vec<&'a str> {
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
        // Scheduling and monitoring tools keep the CLI alive after the turn ends; a live
        // coordinator finished in 100 s, scheduled a wakeup and was killed at the time limit.
        "--disallowedTools",
        // The read-only coordinator also loses Bash: a live GLM coordinator submitted its repair,
        // then ran `sleep` until the time limit. Read, Grep and Glob still inspect the checkout.
        if execution["team_role"] == "coordinator" {
            "ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor,RemoteTrigger,PushNotification,Bash"
        } else {
            "ScheduleWakeup,CronCreate,CronDelete,CronList,Monitor,RemoteTrigger,PushNotification"
        },
    ];
    // Only exact catalog-supported levels reach this builder after roster validation.
    let effort = match execution["reasoning_effort"].as_str() {
        Some("low") => Some("low"),
        Some("medium") => Some("medium"),
        Some("high") => Some("high"),
        Some("xhigh") => Some("xhigh"),
        Some("max") => Some("max"),
        _ => None,
    };
    if let Some(effort) = effort {
        args.extend(["--effort", effort]);
    }
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
