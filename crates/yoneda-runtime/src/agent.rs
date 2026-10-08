use crate::{
    broker::broker,
    err, field,
    process::{bounded_output, untrusted},
    workspace::export_with_baseline,
};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use yoneda_core::Result;
pub(crate) async fn execute(job: &Value, root: &Path) -> Result<Value> {
    let baseline = super::jobs::workspace(job, root).await?;
    #[cfg(target_os = "linux")]
    {
        Command::new("chown")
            .args(["-R", "1000:1000", "/work", "/home/agent"])
            .status()
            .await
            .map_err(err)?;
    }
    let payload = &job["payload"];
    let execution = &payload["execution"];
    let model = field(job, "model")?;
    let prompt = crate::prompt::prompt(payload)?;
    let mcp = json!({"mcpServers":{"yonedarepo":{"command":"/usr/local/bin/yoneda-runtime","args":["mcp"]}}});
    std::fs::write("/home/agent/mcp.json", mcp.to_string()).map_err(err)?;
    std::fs::create_dir_all("/home/agent/.codex").map_err(err)?;
    let config = format!(
        "model = {model:?}\nmodel_provider = \"yoneda\"\nmodel_reasoning_effort = \"low\"\n[model_providers.yoneda]\nname = \"Yoneda scoped proxy\"\nbase_url = \"http://codex.yoneda.internal/v1\"\nwire_api = \"responses\"\n[mcp_servers.yonedarepo]\ncommand = \"/usr/local/bin/yoneda-runtime\"\nargs = [\"mcp\"]\n"
    );
    std::fs::write("/home/agent/.codex/config.toml", config).map_err(err)?;
    #[cfg(target_os = "linux")]
    {
        Command::new("chown")
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
        let settings = json!({"security":{"auth":{"selectedType":"gemini-api-key","enforcedType":"gemini-api-key"}},"model":{"name":model,"maxSessionTurns":24},"telemetry":{"enabled":false},"privacy":{"usageStatisticsEnabled":false},"mcp":{"allowed":["yonedarepo"]},"mcpServers":mcp["mcpServers"],"tools":{"exclude":["google_web_search","web_fetch"]}});
        std::fs::write("/etc/gemini-cli/settings.json", settings.to_string()).map_err(err)?;
    }
    let mut command = Command::new(harness);
    untrusted(&mut command, root);
    if execution["harness"] == "codex" {
        command.args([
            "exec",
            "--ephemeral",
            "--json",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--model",
            model,
            &prompt,
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
                &prompt,
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
        command.args([
            "-p",
            &prompt,
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
            "--max-budget-usd",
            "1.00",
        ]);
    }
    broker(
        "/progress",
        json!({"progress":{"stage":"harness_running"}}),
        true,
    )
    .await?;
    let output = bounded_output(&mut command).await?;
    let evidence = broker("/evidence", json!({"content":output.to_string()}), true).await?;
    if output["exit"] != 0 {
        return Err(err(format!(
            "Harness exited {}. Transcript evidence {}",
            output["exit"], evidence["digest"]
        )));
    }
    if execution["role"] == "research" {
        return Ok(json!({"transcript":evidence["digest"],"model":model}));
    }
    let files = export_with_baseline(root, &baseline)?;
    let uploaded = broker("/workspace", json!({"files":files}), true).await?;
    Ok(json!({"workspace":uploaded["digest"],"transcript":evidence["digest"],"model":model}))
}
