use crate::{
    err, field,
    process::{bounded_output, untrusted},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::process::Command;
use yoneda_core::Result;
pub(crate) async fn execute(job: &Value, root: &Path) -> Result<Value> {
    super::jobs::workspace(job, root).await?;
    #[cfg(target_os = "linux")]
    {
        Command::new("chown")
            .args(["-R", "1000:1000", "/work", "/home/agent"])
            .status()
            .await
            .map_err(err)?;
    }
    if !job["payload"]["policy"]["build"].is_null() {
        let policy: yoneda_core::Policy =
            serde_json::from_value(job["payload"]["policy"].clone()).map_err(err)?;
        yoneda_core::build::validate_policy(&policy)?;
        let profile = policy
            .build
            .as_ref()
            .ok_or_else(|| err("Missing build profile"))?;
        let mut report = run_profile(root, profile).await?;
        if let Some(directory) = &profile.static_dir {
            if let Ok(files) = crate::site::assets(root, directory) {
                crate::broker::broker("/site", json!({"files":files}), true).await?;
            } else {
                report["static_error"] = json!("Static output missing, unsafe or exceeds limits");
            }
        }
        report["environment"] = json!(yoneda_core::build::ENVIRONMENT);
        report["suite"] = json!(policy.suite);
        return Ok(report);
    }
    let mut command = Command::new("cargo");
    untrusted(&mut command, root);
    command.args(["build", "--offline", "--release", "--bin", "retry-client"]);
    let build = bounded_output(&mut command).await?;
    let mut cases = Vec::new();
    if build["exit"] == 0 {
        for case in yoneda_core::retry::cases_for_suite(field(&job["payload"]["policy"], "suite")?)?
        {
            let mut command = Command::new("/work/target/release/retry-client");
            untrusted(&mut command, root);
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
            let output = tokio::time::timeout(Duration::from_secs(3), bounded_output(&mut command))
                .await
                .map_err(err)??;
            cases.push(json!({"input":case,"exit":output["exit"],"actual":serde_json::from_str::<Value>(output["stdout"].as_str().unwrap_or_default()).unwrap_or(Value::Null),"output":output}));
        }
    }
    Ok(
        json!({"build":build,"cases":cases,"environment":crate::supervisor::health()["environment"],"suite":job["payload"]["policy"]["suite"]}),
    )
}

pub(crate) async fn run_profile(
    root: &Path,
    profile: &yoneda_core::build::BuildProfile,
) -> Result<Value> {
    let mut setup = Vec::new();
    let mut commands = Vec::new();
    let mut setup_ok = true;
    for spec in &profile.setup {
        let output = run_command(root, spec).await?;
        setup_ok &= output["exit"] == 0;
        setup.push(json!({"name":spec.name,"output":output}));
        if !setup_ok {
            break;
        }
    }
    if setup_ok {
        for spec in &profile.checks {
            let output = run_command(root, spec).await?;
            commands.push(json!({"name":spec.name,"output":output}));
        }
    }
    Ok(json!({"setup":setup,"commands":commands}))
}
async fn run_command(root: &Path, spec: &yoneda_core::build::CommandSpec) -> Result<Value> {
    let program = spec.argv.first().ok_or_else(|| err("Empty command"))?;
    let mut command = Command::new(program);
    untrusted(&mut command, root);
    command.args(&spec.argv[1..]);
    match tokio::time::timeout(
        Duration::from_secs(spec.timeout_seconds),
        bounded_output(&mut command),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => Ok(
            json!({"exit":null,"timeout":true,"stdout":"","stderr":"Command exceeded approved timeout"}),
        ),
    }
}
