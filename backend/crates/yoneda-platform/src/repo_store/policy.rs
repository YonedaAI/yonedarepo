//! The repository's landing policy and check names.
use crate::storage::bad;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use yoneda_core::Result;

/// Landing policy: which checks must pass and how many independent approvals are needed.
/// `runners` are owner-defined commands the platform executes itself; definitions come
/// from policy, never from the commit under test, so a change cannot weaken its own check.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub required_checks: Vec<String>,
    pub approvals: u32,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub runners: BTreeMap<String, Runner>,
    /// Review classes that satisfy the approval requirement without a human (semantic
    /// approval). Only `docs`, `formatting` and `comment_only` may be listed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auto_approve: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Runner {
    /// argv, executed without a shell unless the owner writes `["sh", "-c", ...]`.
    pub command: Vec<String>,
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u32,
}
fn default_timeout() -> u32 {
    600
}

impl Policy {
    pub fn parse(value: &Value) -> Result<(Self, Value, String)> {
        let policy: Policy = serde_json::from_value(value.clone())
            .map_err(|e| bad(&format!("Invalid policy: {e}")))?;
        policy
            .required_checks
            .iter()
            .chain(policy.runners.keys())
            .try_for_each(|name| check_name(name))?;
        if policy.runners.len() > 32
            || policy.runners.values().any(|r| {
                r.command.is_empty()
                    || r.command.len() > 64
                    || r.command.iter().any(|a| a.len() > 4096 || a.contains('\0'))
                    || !(1..=3600).contains(&r.timeout_seconds)
            })
        {
            return Err(bad(
                "Runners need 1-64 argv entries and a 1-3600 second timeout (at most 32 runners)",
            ));
        }
        if let Some(class) = policy
            .auto_approve
            .iter()
            .find(|c| !crate::platform_review::ReviewClass::AUTO_APPROVABLE.contains(&c.as_str()))
        {
            return Err(bad(&format!(
                "Review class {class} cannot be auto-approved (only docs, formatting, comment_only)"
            )));
        }
        let json = serde_json::to_value(&policy).map_err(|e| bad(&e.to_string()))?;
        let digest = yoneda_core::fingerprint(&json)?;
        Ok((policy, json, digest))
    }
}

pub fn check_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.bytes().enumerate().all(|(i, b)| {
            b.is_ascii_lowercase()
                || b.is_ascii_digit()
                || (i > 0 && matches!(b, b'.' | b'_' | b'-'))
        });
    if valid {
        Ok(())
    } else {
        Err(bad(
            "Check names are lowercase [a-z0-9._-], up to 64 characters",
        ))
    }
}
