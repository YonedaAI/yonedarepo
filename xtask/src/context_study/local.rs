use super::{
    client::{Client, text},
    provision::Project,
};
use crate::process::Result;
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
pub(super) async fn execute(
    client: &Client,
    project: &Project,
    case: &Value,
    connection: &Value,
    credentials: &Path,
) -> Result<(String, Value)> {
    let secret: Value = serde_json::from_slice(&std::fs::read(credentials)?)?;
    let provider = text(connection, "provider")?;
    let key=secret["local_providers"][provider]["key"].as_str().ok_or("Local continuation needs a process-local provider key; Worker vault keys are never exported")?;
    let registry: Vec<Value> = serde_json::from_str(include_str!(
        "../../../backend/crates/yoneda-core/src/providers.json"
    ))?;
    let definition = registry
        .iter()
        .find(|p| p["id"] == provider)
        .ok_or("Unknown local provider")?;
    let base = if connection["routing"]["plan"] == "token_plan" {
        text(
            &definition["token_plan_regions"],
            text(&connection["routing"], "region")?,
        )?
    } else {
        text(definition, "api_base")?
    };
    let session = client.session(&project.id, &project.grant).await?;
    let attempt=client.mcp(&project.id,&project.grant,Some(&session),"attempt_begin",json!({"request_id":uuid::Uuid::new_v4().to_string(),"intent":case["brief"],"criteria":case["criteria"]})).await?;
    let run = text(&attempt["run"], "id")?.to_owned();
    let work = tempfile::tempdir()?;
    let config = tempfile::tempdir()?;
    super::git::git(
        work.path(),
        &project.grant,
        &["clone", text(&attempt, "git_url")?, "."],
    )
    .await?;
    std::fs::write(
        config.path().join("relay.mjs"),
        include_str!("../../../tools/context-study/mcp-relay.mjs"),
    )?;
    let mut mcp_url = reqwest::Url::parse(&client.url)?;
    if ["127.0.0.1", "localhost", "[::1]"].contains(&mcp_url.host_str().unwrap_or_default()) {
        mcp_url.set_host(Some("host.docker.internal"))?;
    }
    std::fs::write(
        config.path().join("connection.json"),
        serde_json::to_vec(
            &json!({"url":format!("{}/mcp/{}",mcp_url.as_str().trim_end_matches('/'),project.id),"token":project.grant,"session":session}),
        )?,
    )?;
    let mcp = json!({"mcpServers":{"yonedarepo":{"command":"node","args":["/config/relay.mjs","/config/connection.json"]}}});
    std::fs::write(config.path().join("mcp.json"), serde_json::to_vec(&mcp)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            config.path().join("connection.json"),
            std::fs::Permissions::from_mode(0o600),
        )?;
    }
    let initial = client
        .mcp(
            &project.id,
            &project.grant,
            Some(&session),
            "repo_context",
            json!({}),
        )
        .await?;
    // A fresh CLI has no chat history. Notes only appear in the flat condition.
    let prompt = format!(
        "You are a fresh LOCAL YonedaRepo continuation agent. Implement: {}. Source is /work. Keep public/events.mjs API. First use repo_context, then context_search/context_get where available. Publish findings and explicit links to any previous records you rely on with context_publish, using attempt_id {} and intent_id {}. Retrieval may be unavailable in this condition; continue with supplied information. Initial notes: {}. Implement and finish; do not submit, select or publish source. The trusted runner captures after you exit.",
        case["brief"],
        attempt["attempt_id"],
        attempt["intent_id"],
        initial.get("plain_notes").unwrap_or(&json!([]))
    );
    let name = format!("yoneda-study-local-{}", uuid::Uuid::new_v4());
    #[cfg(unix)]
    let user = {
        use std::os::unix::fs::MetadataExt;
        let meta = std::fs::metadata(work.path())?;
        format!("{}:{}", meta.uid(), meta.gid())
    };
    #[cfg(not(unix))]
    let user = "1000:1000".to_owned();
    let mut command = Command::new("docker");
    command
        .args([
            "run",
            "--rm",
            "--name",
            &name,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "2g",
            "--cpus",
            "2",
            "--pids-limit",
            "128",
            "--user",
            &user,
            "--tmpfs",
            "/tmp:rw,nosuid,size=128m",
            "--entrypoint",
            "claude",
            "--workdir",
            "/work",
        ])
        .arg("--mount")
        .arg(format!("type=bind,src={},dst=/work", work.path().display()))
        .arg("--mount")
        .arg(format!(
            "type=bind,src={},dst=/config,readonly",
            config.path().display()
        ))
        .args([
            "-e",
            "ANTHROPIC_BASE_URL",
            "-e",
            "ANTHROPIC_API_KEY",
            "-e",
            "ANTHROPIC_AUTH_TOKEN",
            "-e",
            "ANTHROPIC_CUSTOM_HEADERS",
            "-e",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096",
            "-e",
            "HOME=/tmp/agent",
            "-e",
            "DISABLE_NONESSENTIAL_TRAFFIC=1",
        ])
        .args([
            "yonedarepo-runtime:layout",
            "-p",
            &prompt,
            "--model",
            text(connection, "model")?,
            "--output-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--mcp-config",
            "/config/mcp.json",
            "--setting-sources",
            "",
            "--dangerously-skip-permissions",
            "--max-turns",
            "60",
        ])
        .env("ANTHROPIC_BASE_URL", base)
        .env(
            "ANTHROPIC_API_KEY",
            if provider == "mimo" { key } else { "" },
        )
        .env(
            "ANTHROPIC_AUTH_TOKEN",
            if provider == "zai" { key } else { "" },
        )
        .env(
            "ANTHROPIC_CUSTOM_HEADERS",
            if provider == "mimo" {
                format!("api-key: {key}")
            } else {
                String::new()
            },
        )
        .kill_on_drop(true);
    let started = std::time::Instant::now();
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(600), command.output()).await;
    let mut metrics = json!({"fresh_cli":true,"harness":"claude","model":connection["model"],"duration_ms":started.elapsed().as_millis(),"exit":null,"provider_tokens":null,"limit_kind":"cli_turns","max_turns":60});
    if let Ok(output) = outcome {
        let output = output?;
        metrics["exit"] = json!(output.status.code());
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Ok(event) = serde_json::from_str::<Value>(line)
                && event["type"] == "result"
            {
                metrics["provider_tokens"] = event["usage"].clone();
                metrics["is_error"] = event["is_error"].clone();
            }
        }
        if !output.status.success() {
            client
                .api(
                    &format!("repos/{}/cancel_run", project.id),
                    Some(json!({"run_id":run})),
                )
                .await?;
            return Ok((run, metrics));
        }
    } else {
        let _ = Command::new("docker")
            .args(["rm", "-f", &name])
            .output()
            .await;
        metrics["timeout"] = json!(true);
        client
            .api(
                &format!("repos/{}/cancel_run", project.id),
                Some(json!({"run_id":run})),
            )
            .await?;
        return Ok((run, metrics));
    }
    let files = yoneda_runtime::export_workspace(work.path())?;
    let trusted = tempfile::tempdir()?;
    super::git::git(
        trusted.path(),
        &project.grant,
        &["clone", text(&attempt, "git_url")?, "."],
    )
    .await?;
    for entry in std::fs::read_dir(trusted.path())? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    yoneda_runtime::capture(
        trusted.path(),
        Some(text(&attempt["base"], "commit")?),
        &files,
        "Trusted capture of fresh local continuation",
    )
    .await?;
    super::git::git(
        trusted.path(),
        &project.grant,
        &["push", text(&attempt, "git_url")?, "HEAD:refs/heads/main"],
    )
    .await?;
    client
        .mcp(
            &project.id,
            &project.grant,
            Some(&session),
            "attempt_submit",
            json!({"attempt_id":attempt["attempt_id"]}),
        )
        .await?;
    Ok((run, metrics))
}
