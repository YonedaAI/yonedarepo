//! Owner-approved commands executed in a separate clean evaluator.
use crate::{Check, Error, Policy, Result, validate_path};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

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
    Ok(profile
        .checks
        .iter()
        .map(|command| {
            let exit = observation(report, "commands", &command.name);
            Check {
                name: command.name.clone(),
                status: if setup_ok && bundle_ok && exit == Some(0) {
                    "pass"
                } else {
                    "fail"
                }
                .into(),
                detail: format!("Clean evaluator exit: {exit:?}; setup succeeded: {setup_ok}; immutable policy satisfied: {bundle_ok}"),
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
mod tests {
    use super::*;
    use serde_json::json;

    fn policy() -> Policy {
        serde_json::from_value(json!({"version":"v1","suite":"commands-v1",
            "environment":ENVIRONMENT,"required_checks":["tests"],"build":{"checks":[
                {"name":"tests","argv":["sh","/opt/yoneda/test-bundle/run.sh"],"timeout_seconds":10}],
                "test_bundle":{"digest":"a".repeat(64),"protected_paths":["tests","scripts/runner.sh"]}}})).unwrap()
    }

    #[test]
    fn old_build_profile_without_bundle_remains_valid() {
        let old: BuildProfile = serde_json::from_value(
            json!({"checks":[{"name":"x","argv":["true"],"timeout_seconds":1}]}),
        )
        .unwrap();
        assert!(old.test_bundle.is_none());
    }

    #[test]
    fn bundle_runner_path_must_not_depend_on_unexpanded_shell_variables() {
        let mut policy = policy();
        policy.build.as_mut().unwrap().checks[0].argv[1] = "$YONEDA_TEST_BUNDLE/run.sh".into();
        assert!(validate_policy(&policy).is_err());
    }

    #[test]
    fn zero_exit_cannot_pass_without_exact_bundle_and_clean_protected_paths() {
        let policy = policy();
        let report = json!({"setup":[],"commands":[{"name":"tests","output":{"exit":0}}],
            "test_bundle_digest":"wrong","protected_changes":[]});
        assert_eq!(
            checks_from_report(&policy, &report).unwrap()[0].status,
            "fail"
        );
        let report = json!({"setup":[],"commands":[{"name":"tests","output":{"exit":0}}],
            "test_bundle_digest":"a".repeat(64),"protected_changes":["tests/run.sh"]});
        assert_eq!(
            checks_from_report(&policy, &report).unwrap()[0].status,
            "fail"
        );
        let report = json!({"setup":[],"commands":[{"name":"tests","output":{"exit":0}}],
            "test_bundle_digest":"a".repeat(64),"protected_changes":["src/lib.rs"]});
        assert_eq!(
            checks_from_report(&policy, &report).unwrap()[0].status,
            "pass"
        );
    }
}
