use crate::{
    err, field,
    process::{bounded_output, untrusted},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::process::Command;
use yoneda_core::Result;
#[path = "evaluation_commands.rs"]
mod commands;
#[path = "evaluation_guided.rs"]
mod guided;
pub(crate) use commands::run_profile;
pub(crate) async fn execute(job: &Value, root: &Path) -> Result<Value> {
    guided::validate(job)?;
    let api_source = crate::source_workspace_job::enabled(job);
    let source_session = if api_source {
        Some(crate::source_workspace_run::SourceRun::prepare(
            job,
            root.parent()
                .ok_or_else(|| err("Evaluation source parent missing"))?,
            true,
        )?)
    } else {
        None
    };
    let root = source_session
        .as_ref()
        .map_or(root, |session| session.root());
    let git_native = crate::transport::enabled(job);
    let mut changed_protected = None;
    if api_source {
        // Exact captured metadata was checked before mount; COW checker output is disposable.
    } else if git_native {
        let revision = &job["payload"]["candidate"]["revision"];
        let commit = field(revision, "commit")?;
        let base = field(&job["payload"]["candidate"]["base"], "commit")?;
        let parents = approved_parents(job, base)?;
        crate::git_revision::verify_git_parents(
            "http://git.yoneda.internal/target",
            commit,
            &parents,
        )
        .await?;
        let files =
            crate::git::read_git_revision("http://git.yoneda.internal/target", commit).await?;
        if let Some(policy) = job["payload"]["policy"]["build"]["test_bundle"].as_object() {
            let base = field(&job["payload"]["candidate"]["base"], "commit")?;
            let baseline =
                crate::git::read_git_revision("http://git.yoneda.internal/canonical", base).await?;
            changed_protected = Some(protected_delta(
                &baseline,
                &files,
                policy["protected_paths"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            ));
        }
        crate::transport::materialize_git(root, &files)?;
    } else {
        super::jobs::workspace(job, root).await?;
    }
    #[cfg(target_os = "linux")]
    if !api_source {
        Command::new("/usr/bin/chown")
            .args(["-R", "1000:1000", "/work", "/home/agent"])
            .status()
            .await
            .map_err(err)?;
    }
    let result = run_evaluation(job, root, git_native, changed_protected).await;
    if let Some(session) = source_session {
        session.close_evaluation()?;
    }
    result
}
async fn run_evaluation(
    job: &Value,
    root: &Path,
    git_native: bool,
    changed_protected: Option<Vec<String>>,
) -> Result<Value> {
    let guide = guided::validate(job)?;
    if !job["payload"]["policy"]["build"].is_null() {
        let policy: yoneda_core::Policy =
            serde_json::from_value(job["payload"]["policy"].clone()).map_err(err)?;
        yoneda_core::build::validate_policy(&policy)?;
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
                    report["app_policy_digest"] = json!(yoneda_core::fingerprint(
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
        report["environment"] = json!(yoneda_core::build::ENVIRONMENT);
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
        if git_native {
            fields["protected_changes"] =
                json!(changed_protected.unwrap_or_else(|| protected_changes(job, profile)));
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

fn protected_delta<'a>(
    before: &crate::transport::GitWorkspace,
    after: &crate::transport::GitWorkspace,
    protected_paths: impl Iterator<Item = &'a str>,
) -> Vec<String> {
    let protected = protected_paths.collect::<Vec<_>>();
    before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|path| {
            let overlaps = protected.iter().any(|protected| {
                path.as_str() == *protected
                    || path.starts_with(&format!("{protected}/"))
                    || protected.starts_with(&format!("{path}/"))
            });
            if !overlaps {
                return false;
            }
            match (before.get(*path), after.get(*path)) {
                (Some(left), Some(right)) => {
                    left.executable != right.executable || left.bytes != right.bytes
                }
                _ => true,
            }
        })
        .map(|path| (*path).clone())
        .collect()
}

fn protected_changes(job: &Value, profile: &yoneda_core::build::BuildProfile) -> Vec<String> {
    let Some(policy) = &profile.test_bundle else {
        return Vec::new();
    };
    let Some(changes) = job["payload"]["protected_changes"].as_array() else {
        return policy.protected_paths.clone();
    };
    changes
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn approved_parents<'a>(job: &'a Value, base: &'a str) -> Result<Vec<&'a str>> {
    let Some(parents) = job["payload"]["candidate"]["approved_parents"].as_array() else {
        if job["payload"]["candidate"]["refresh_of"].is_string() {
            return Err(err(
                "Refreshed candidate omitted its frozen approved parents",
            ));
        }
        return Ok(vec![base]);
    };
    if job["payload"]["candidate"]["refresh_of"].as_str().is_none() {
        return Err(err(
            "Only a refreshed candidate may declare two approved parents",
        ));
    }
    let values = parents
        .iter()
        .map(|parent| {
            parent
                .as_str()
                .ok_or_else(|| err("Invalid frozen approved parent"))
        })
        .collect::<Result<Vec<_>>>()?;
    if values.len() != 2 || values[0] != base {
        return Err(err(
            "Refreshed candidate parent list differs from its approved head",
        ));
    }
    Ok(values)
}

#[cfg(test)]
#[path = "tests/evaluation_api_integrity.rs"]
mod api_integrity_tests;
#[cfg(test)]
#[path = "tests/evaluation_bundle_security.rs"]
mod bundle_security_tests;
