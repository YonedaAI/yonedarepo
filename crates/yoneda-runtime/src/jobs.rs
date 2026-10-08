use crate::{
    broker::broker,
    err, field,
    git::{capture, git},
    process::{bounded_output, untrusted},
    workspace::{export_workspace, materialize},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;
use yoneda_core::{Result, Workspace};
async fn workspace(job: &Value, root: &Path) -> Result<()> {
    let result = broker("/source", json!({}), true).await?;
    let files: Workspace = serde_json::from_value(result["files"].clone()).map_err(err)?;
    materialize(root, &files)?;
    let _ = job;
    Ok(())
}

pub(crate) async fn execute_job(job: &Value) -> Result<Value> {
    let root = PathBuf::from("/work/repo");
    std::fs::create_dir_all(&root).map_err(err)?;
    match field(job, "kind")? {
        "agent" => {
            workspace(job, &root).await?;
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
            let prompt = format!(
                "You are an isolated YonedaRepo {} agent. Strategy: {}. Intent: {}. Criteria: {}. First call repo_context, then artifact_get for EVERY shared artifact ID. The checkout is the frozen base. {} Publish a concise artifact through artifact_publish with metadata.assumptions as an ARRAY of objects, each with statement (string), metric (string), limit (integer), path (string); research MUST include at least one. For the latency assertion use metric upstream_p99_ms, limit 100, path src/main.rs. End by calling execution_complete. Do not alter the CLI contract. Use no external packages: cargo build --offline --release --bin retry-client must work. CLI contract: retry-client METHOD COMMA_SEPARATED_STATUSES LATENCY_MS BUDGET_MS MAX_ATTEMPTS emits JSON {{attempts,elapsed_ms,status}}. Retry only GET on 429 or >=500; backoff 10*2^(retry_index-1) ms; include latency and backoff in total deadline; clamp attempts to 1..10; first request always occurs. Existing source intentionally lacks retries. Research assumption to examine: upstream_p99_ms <= 100. Stay concise; finish within the configured deadline.",
                field(execution, "role")?,
                field(execution, "strategy")?,
                payload["run"]["intent"],
                payload["run"]["criteria"],
                if execution["role"] == "research" {
                    "Research only: inspect source, publish concrete guidance and assumptions; do not change source."
                } else {
                    "Implement the intent in the source files. Different approaches should be visible in code and explanations."
                }
            );
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
            let mut command = Command::new(if execution["harness"] == "codex" {
                "codex"
            } else {
                "claude"
            });
            untrusted(&mut command, &root);
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
            } else {
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
            let files = export_workspace(&root)?;
            let uploaded = broker("/workspace", json!({"files":files}), true).await?;
            Ok(
                json!({"workspace":uploaded["digest"],"transcript":evidence["digest"],"model":model}),
            )
        }
        "capture" => {
            let data = broker("/workspace", json!({}), true).await?;
            let files: Workspace = serde_json::from_value(data["files"].clone()).map_err(err)?;
            git(&root, &["init", "-b", "main"]).await?;
            git(
                &root,
                &[
                    "fetch",
                    "http://git.yoneda.internal/canonical",
                    field(&job["payload"]["base"], "commit")?,
                ],
            )
            .await?;
            let mut result = capture(
                &root,
                Some(field(&job["payload"]["base"], "commit")?),
                &files,
                "YonedaRepo captured candidate",
            )
            .await?;
            git(
                &root,
                &[
                    "push",
                    "http://git.yoneda.internal/candidate",
                    "HEAD:refs/heads/main",
                ],
            )
            .await?;
            result["id"] = json!(format!("candidate:{}:{}", field(job, "id")?, job["epoch"]));
            result["revision"] = json!({"repository":job["fork"],"commit":result["commit"]});
            result["summary"] = json!(format!(
                "{} approach",
                job["payload"]["execution"]["strategy"]
                    .as_str()
                    .unwrap_or("Candidate")
            ));
            Ok(result)
        }
        "evaluate" => {
            workspace(job, &root).await?;
            #[cfg(target_os = "linux")]
            {
                Command::new("chown")
                    .args(["-R", "1000:1000", "/work", "/home/agent"])
                    .status()
                    .await
                    .map_err(err)?;
            }
            let mut command = Command::new("cargo");
            untrusted(&mut command, &root);
            command.args(["build", "--offline", "--release", "--bin", "retry-client"]);
            let build = bounded_output(&mut command).await?;
            let mut cases = Vec::new();
            if build["exit"] == 0 {
                for case in
                    yoneda_core::retry::cases_for_suite(field(&job["payload"]["policy"], "suite")?)?
                {
                    let mut command = Command::new("/work/target/release/retry-client");
                    untrusted(&mut command, &root);
                    command.args([
                        case.method.clone(),
                        case.statuses
                            .iter()
                            .map(u16::to_string)
                            .collect::<Vec<_>>()
                            .join(","),
                        case.latency.to_string(),
                        case.budget.to_string(),
                        case.max_attempts.to_string(),
                    ]);
                    let output =
                        tokio::time::timeout(Duration::from_secs(3), bounded_output(&mut command))
                            .await
                            .map_err(err)??;
                    cases.push(json!({"input":case,"exit":output["exit"],"actual":serde_json::from_str::<Value>(output["stdout"].as_str().unwrap_or_default()).unwrap_or(Value::Null),"output":output}));
                }
            }
            Ok(
                json!({"build":build,"cases":cases,"environment":crate::supervisor::health()["environment"],"suite":job["payload"]["policy"]["suite"]}),
            )
        }
        "publish" => {
            git(&root, &["init", "-b", "main"]).await?;
            let target = field(&job["payload"]["target"], "commit")?;
            let expected = field(&job["payload"]["expected"], "commit")?;
            git(
                &root,
                &["fetch", "http://git.yoneda.internal/candidate", target],
            )
            .await?;
            git(
                &root,
                &["fetch", "http://git.yoneda.internal/canonical", "main"],
            )
            .await?;
            let observed = git(&root, &["rev-parse", "FETCH_HEAD"]).await?;
            if observed == target {
                return Ok(json!({"commit":target,"recovered":true}));
            }
            if observed != expected {
                return Ok(json!({"conflict":true,"observed":observed}));
            }
            git(&root, &["merge-base", "--is-ancestor", expected, target]).await?;
            git(
                &root,
                &[
                    "push",
                    &format!("--force-with-lease=refs/heads/main:{expected}"),
                    "http://git.yoneda.internal/canonical",
                    &format!("{target}:refs/heads/main"),
                ],
            )
            .await?;
            let result = git(
                &root,
                &[
                    "ls-remote",
                    "http://git.yoneda.internal/canonical",
                    "refs/heads/main",
                ],
            )
            .await?;
            if result.split_whitespace().next() != Some(target) {
                return Err(err("Publication readback did not match selected commit"));
            }
            Ok(json!({"commit":target}))
        }
        _ => Err(err("Unknown job kind")),
    }
}
