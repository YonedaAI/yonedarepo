use crate::{
    err, field,
    process::{bounded_output, untrusted},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::process::Command;
use yoneda_agents_core::Result;
#[path = "evaluation_commands.rs"]
mod commands;
#[path = "evaluation_guided.rs"]
mod guided;
pub(crate) use commands::run_profile;
pub(crate) async fn execute(job: &Value, root: &Path) -> Result<Value> {
    guided::validate(job)?;
    if !crate::source_workspace_job::enabled(job) {
        return Err(err(
            "Evaluators read the captured revision through lazy source",
        ));
    }
    let (owned, parent) = (
        job.clone(),
        root.parent()
            .ok_or_else(|| err("Evaluation source parent missing"))?
            .to_path_buf(),
    );
    let session = crate::source_workspace_run::off_runtime(move || {
        crate::source_workspace_run::SourceRun::prepare(&owned, &parent, true)
    })
    .await?;
    let result = run_evaluation(job, session.root()).await;
    crate::source_workspace_run::off_runtime(move || session.close_evaluation()).await?;
    result
}
async fn run_evaluation(job: &Value, root: &Path) -> Result<Value> {
    let guide = guided::validate(job)?;
    if !job["payload"]["policy"]["build"].is_null() {
        let policy: yoneda_agents_core::Policy =
            serde_json::from_value(job["payload"]["policy"].clone()).map_err(err)?;
        yoneda_agents_core::build::validate_policy(&policy)?;
        let profile = policy
            .build
            .as_ref()
            .ok_or_else(|| err("Missing build profile"))?;
        let api_integrity = if crate::source_workspace_job::enabled(job) {
            Some(crate::source_workspace_integrity::fields(
                job, profile, None,
            )?)
        } else {
            None
        };
        if let Some(fields) = api_integrity
            .and_then(|fields| crate::source_workspace_integrity::blocked_report(fields, &policy))
        {
            let mut fields = fields;
            guided::record(&mut fields, guide.as_ref());
            return Ok(fields);
        }
        let bundle_digest = crate::test_bundle::install(profile.test_bundle.as_ref()).await?;
        let mut report = match guide.as_ref() {
            Some(guide) => commands::run_profile_with_guide(root, profile, Some(guide)).await?,
            None => run_profile(root, profile).await?,
        };
        if profile.app.is_some() {
            let commit = field(&job["payload"]["candidate"]["revision"], "commit")?;
            match crate::app_bundle::encode(root, commit, &policy) {
                Ok((content, digest)) => {
                    let stored =
                        crate::broker::broker("/app-bundle", json!({"content":content}), true)
                            .await?;
                    if stored["digest"] != digest {
                        return Err(err("App bundle storage digest mismatch"));
                    }
                    report["app_bundle_digest"] = json!(digest);
                    report["app_revision"] = json!(commit);
                    report["app_policy_digest"] = json!(yoneda_agents_core::fingerprint(
                        &serde_json::to_value(&policy).map_err(err)?
                    )?);
                }
                Err(_) => {
                    report["app_error"] = json!("App output missing, unsafe or exceeds limits");
                }
            }
        }
        if let Some(directory) = &profile.static_dir {
            match crate::site::assets(root, directory) {
                Ok(files) => {
                    crate::broker::broker("/site", json!({"files":files}), true).await?;
                }
                Err(error) => crate::site::record_failure(&mut report, &error),
            }
        }
        report["environment"] = json!(yoneda_agents_core::build::ENVIRONMENT);
        report["suite"] = json!(policy.suite);
        let mut fields = crate::test_bundle::report_fields(
            profile.test_bundle.as_ref(),
            bundle_digest.as_deref(),
            job,
        );
        if crate::source_workspace_job::enabled(job) {
            fields =
                crate::source_workspace_integrity::fields(job, profile, bundle_digest.as_deref())?;
        }
        if let Some(object) = report.as_object_mut() {
            object.extend(fields.as_object().cloned().unwrap_or_default());
        }
        return Ok(report);
    }
    let mut command = Command::new("cargo");
    untrusted(&mut command, root);
    command.args(["build", "--offline", "--release", "--bin", "retry-client"]);
    let build = bounded_output(&mut command).await?;
    let mut cases = Vec::new();
    if build["exit"] == 0 {
        for case in
            yoneda_agents_core::retry::cases_for_suite(field(&job["payload"]["policy"], "suite")?)?
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

#[cfg(test)]
#[path = "tests/evaluation_api_integrity.rs"]
mod api_integrity_tests;
