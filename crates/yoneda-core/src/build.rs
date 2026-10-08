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
    Ok(profile
        .checks
        .iter()
        .map(|command| {
            let exit = observation(report, "commands", &command.name);
            Check {
                name: command.name.clone(),
                status: if setup_ok && exit == Some(0) {
                    "pass"
                } else {
                    "fail"
                }
                .into(),
                detail: format!("Clean evaluator exit: {exit:?}; setup succeeded: {setup_ok}"),
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
