use crate::{
    err, field,
    process::{bounded_output, untrusted},
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};
use tokio::process::Command;
use yoneda_core::Result;
pub(crate) async fn execute(job: &Value, root: &Path) -> Result<Value> {
    let git_native = crate::transport::enabled(job);
    let mut changed_protected = None;
    if git_native {
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
    {
        Command::new("/usr/bin/chown")
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
        let bundle_digest = crate::test_bundle::install(profile.test_bundle.as_ref()).await?;
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
        let mut fields = crate::test_bundle::report_fields(
            profile.test_bundle.as_ref(),
            bundle_digest.as_deref(),
            job,
        );
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
    command.env("YONEDA_TEST_BUNDLE", "/opt/yoneda/test-bundle");
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

#[cfg(test)]
mod bundle_security_tests {
    use super::{approved_parents, protected_delta};
    use crate::transport::{GitFile, GitWorkspace};
    use serde_json::json;
    use yoneda_core::{Policy, build::checks_from_report};

    #[test]
    fn rewriting_or_deleting_the_runner_fails_even_when_candidate_exits_zero() {
        let original = GitWorkspace::from([(
            "tests/run.sh".into(),
            GitFile {
                bytes: b"#!/bin/sh\nrun-tests\n".to_vec(),
                executable: true,
            },
        )]);
        for changed in [
            GitWorkspace::from([(
                "tests/run.sh".into(),
                GitFile {
                    bytes: b"#!/bin/sh\nexit 0\n".to_vec(),
                    executable: true,
                },
            )]),
            GitWorkspace::new(),
        ] {
            let protected = protected_delta(&original, &changed, ["tests/run.sh"].into_iter());
            let policy: Policy = serde_json::from_value(json!({
                "version":"owner-v1","suite":"commands-v1","environment":yoneda_core::build::ENVIRONMENT,
                "required_checks":["owner-tests"],"build":{"checks":[{"name":"owner-tests","argv":["sh","/opt/yoneda/test-bundle/tests/run.sh"],"timeout_seconds":10}],
                "test_bundle":{"digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","protected_paths":["tests/run.sh"]}}
            })).unwrap();
            let report = json!({"test_bundle_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "protected_changes":protected,"commands":[{"name":"owner-tests","output":{"exit":0}}],"setup":[]});
            assert_eq!(
                checks_from_report(&policy, &report).unwrap()[0].status,
                "fail"
            );
        }
    }

    #[test]
    fn only_refreshed_candidates_may_use_two_frozen_parents() {
        let head = "a".repeat(40);
        let source = "b".repeat(40);
        let ordinary = json!({"payload":{"candidate":{"base":{"commit":head}}}});
        assert_eq!(
            approved_parents(&ordinary, &head).unwrap(),
            vec![head.as_str()]
        );
        let refreshed = json!({"payload":{"candidate":{"base":{"commit":head},
            "refresh_of":"candidate:old","approved_parents":[head,source]}}});
        assert_eq!(
            approved_parents(&refreshed, &head).unwrap(),
            vec![head.as_str(), source.as_str()]
        );
        let missing =
            json!({"payload":{"candidate":{"base":{"commit":head},"refresh_of":"candidate:old"}}});
        assert!(approved_parents(&missing, &head).is_err());
        let forged = json!({"payload":{"candidate":{"base":{"commit":head},
            "approved_parents":[head,source]}}});
        assert!(approved_parents(&forged, &head).is_err());
    }
}
