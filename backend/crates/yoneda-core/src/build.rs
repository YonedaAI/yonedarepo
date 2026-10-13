//! Owner-approved commands executed in a separate clean evaluator.
use crate::{Check, Error, Policy, Result, validate_path};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

mod app;
pub use app::{AppManifest, AppMigration};

pub const ENVIRONMENT: &str = "linux-node24-rust1.94-v1";
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CommandSpec {
    pub name: String,
    pub argv: Vec<String>,
    pub timeout_seconds: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BuildProfile {
    /// Owner-approved full-stack execution; absent for legacy/static profiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<AppManifest>,
    #[serde(default)]
    pub setup: Vec<CommandSpec>,
    pub checks: Vec<CommandSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub static_dir: Option<String>,
    /// Immutable owner-approved tests loaded by the evaluator outside candidate source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_bundle: Option<TestBundlePolicy>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TestBundlePolicy {
    /// SHA-256 of canonical JSON encoding of the sorted test bundle workspace.
    pub digest: String,
    /// Repository paths whose candidate changes require a new owner policy.
    #[serde(default)]
    pub protected_paths: Vec<String>,
}
/// Stable digest shared by capture, evaluation, and publication authority.
pub fn policy_digest(policy: &Policy) -> Result<String> {
    crate::fingerprint(
        &serde_json::to_value(policy).map_err(|e| Error::new("ENCODING", e.to_string()))?,
    )
}
pub fn validate_policy(policy: &Policy) -> Result<()> {
    if policy.version.is_empty() || policy.version.len() > 128 || policy.required_checks.is_empty()
    {
        return Err(Error::new(
            "INVALID_INPUT",
            "Policy needs a version and required checks",
        ));
    }
    let Some(profile) = &policy.build else {
        if !["retry-contract-v1", "retry-contract-v2"].contains(&policy.suite.as_str()) {
            return Err(Error::new(
                "INVALID_INPUT",
                "General repositories require a build profile",
            ));
        }
        return Ok(());
    };
    if policy.suite != "commands-v1"
        || policy.environment != ENVIRONMENT
        || profile.checks.is_empty()
        || profile.checks.len() > 12
        || profile.setup.len() > 4
    {
        return Err(Error::new(
            "INVALID_INPUT",
            "Unsupported or empty build profile",
        ));
    }
    let mut names = BTreeSet::new();
    let mut seconds = 0;
    for command in profile.setup.iter().chain(&profile.checks) {
        if command.name.is_empty()
            || command.name.len() > 64
            || !names.insert(&command.name)
            || command.argv.is_empty()
            || command.argv.len() > 64
            || command
                .argv
                .iter()
                .any(|a| a.len() > 4096 || a.contains('\0'))
            || command.argv[0].is_empty()
            || !(1..=90).contains(&command.timeout_seconds)
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Invalid, duplicate or unbounded check command",
            ));
        }
        seconds += command.timeout_seconds;
    }
    if seconds > 90
        || policy
            .required_checks
            .iter()
            .any(|name| !profile.checks.iter().any(|c| &c.name == name))
        || policy.required_checks.iter().collect::<BTreeSet<_>>().len()
            != policy.required_checks.len()
    {
        return Err(Error::new(
            "INVALID_INPUT",
            "Checks must cover the policy within a 90 second execution budget",
        ));
    }
    if let Some(app) = &profile.app {
        app.validate()?;
    }
    if let Some(path) = &profile.static_dir {
        validate_path(path)?;
    }
    if let Some(bundle) = &profile.test_bundle {
        if bundle.digest.len() != 64
            || !bundle
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || bundle.protected_paths.len() > 128
            || bundle
                .protected_paths
                .iter()
                .any(|path| validate_path(path).is_err())
            || bundle.protected_paths.iter().collect::<BTreeSet<_>>().len()
                != bundle.protected_paths.len()
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Invalid immutable test bundle policy",
            ));
        }
        if !profile.checks.iter().any(|command| {
            command
                .argv
                .iter()
                .any(|arg| arg.contains("/opt/yoneda/test-bundle/"))
        }) {
            return Err(Error::new(
                "INVALID_INPUT",
                "A bundle-backed policy must execute its immutable test runner",
            ));
        }
    }
    Ok(())
}
/// Derive verdicts from trusted supervisor exit observations, never agent assertions.
pub fn checks_from_report(policy: &Policy, report: &Value) -> Result<Vec<Check>> {
    validate_policy(policy)?;
    let profile = policy
        .build
        .as_ref()
        .ok_or_else(|| Error::new("INVALID_INPUT", "Missing build profile"))?;
    let setup_ok = profile
        .setup
        .iter()
        .all(|command| observation(report, "setup", &command.name) == Some(0));
    let bundle_ok = profile.test_bundle.as_ref().is_none_or(|bundle| {
        report["test_bundle_digest"].as_str() == Some(bundle.digest.as_str())
            && report["protected_changes"].as_array().is_some_and(|paths| {
                !paths.iter().any(|path| {
                    path.as_str().is_some_and(|path| {
                        bundle.protected_paths.iter().any(|protected| {
                            path == protected
                                || path.starts_with(&format!("{protected}/"))
                                || protected.starts_with(&format!("{path}/"))
                        })
                    })
                })
            })
    });
    let app_ok = profile.app.as_ref().is_none_or(|_| {
        let hex = |value: &Value, lengths: &[usize]| {
            value.as_str().is_some_and(|s| {
                lengths.contains(&s.len())
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        };
        hex(&report["app_bundle_digest"], &[64])
            && hex(&report["app_revision"], &[40, 64])
            && policy_digest(policy)
                .ok()
                .is_some_and(|digest| report["app_policy_digest"].as_str() == Some(digest.as_str()))
    });
    Ok(profile
        .checks
        .iter()
        .map(|command| {
            let exit = observation(report, "commands", &command.name);
            Check {
                name: command.name.clone(),
                status: if setup_ok && bundle_ok && app_ok && exit == Some(0) {
                    "pass"
                } else {
                    "fail"
                }
                .into(),
                detail: format!("Clean evaluator exit: {exit:?}; setup succeeded: {setup_ok}; immutable policy satisfied: {bundle_ok}; app artifact bound: {app_ok}"),
            }
        })
        .collect())
}
fn observation(report: &Value, key: &str, name: &str) -> Option<i64> {
    let matching: Vec<_> = report[key]
        .as_array()?
        .iter()
        .filter(|v| v["name"] == name)
        .collect();
    if matching.len() != 1 {
        return None;
    }
    matching[0]["output"]["exit"].as_i64()
}

#[cfg(test)]
#[path = "build/tests.rs"]
mod tests;
