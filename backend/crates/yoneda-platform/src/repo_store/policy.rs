//! The repository's landing policy and check names.
pub use super::runner::Runner;
use crate::secret_scan::SecretAllow;
use crate::storage::bad;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use yoneda_core::{Error, Result};

/// Landing policy: which checks must pass and how many independent approvals are needed.
/// `runners` are owner-defined checks the platform executes itself (a command, or one model
/// review call); definitions come from policy, never from the commit under test, so a
/// change cannot weaken its own check.
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
    /// Who may post each required check by hand: `owner` or `token:<name>` (token names are
    /// never reused). A required check named by a runner comes only from the platform's run;
    /// any other required check defaults to the owner alone. Omitted when empty, so policies
    /// that never bind posters keep their digest.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub check_posters: BTreeMap<String, Vec<String>>,
    /// Secret-scan false positives the owner accepted, by path and rule. Omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secret_allow: Vec<SecretAllow>,
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
        if policy.runners.len() > 32 {
            return Err(bad("A policy has at most 32 runners"));
        }
        for (name, runner) in &policy.runners {
            runner.validate(name)?;
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
        policy.check_bound_posters()?;
        crate::secret_scan::validate_allow(&policy.secret_allow)?;
        let json = serde_json::to_value(&policy).map_err(|e| bad(&e.to_string()))?;
        let digest = yoneda_core::fingerprint(&json)?;
        Ok((policy, json, digest))
    }

    fn check_bound_posters(&self) -> Result<()> {
        if self.check_posters.len() > 32 {
            return Err(bad("At most 32 checks can bind posters"));
        }
        for (name, posters) in &self.check_posters {
            if !self.required_checks.contains(name) || self.runners.contains_key(name) {
                return Err(bad(&format!(
                    "Posters bind only required checks without a runner ({name})"
                )));
            }
            let valid = |p: &String| {
                p == "owner"
                    || p.strip_prefix("token:")
                        .is_some_and(|t| check_name(t).is_ok())
            };
            if posters.is_empty() || posters.len() > 16 || !posters.iter().all(valid) {
                return Err(bad(
                    "Check posters are 1-16 entries of owner or token:<name>",
                ));
            }
        }
        Ok(())
    }

    /// Whether `principal` may record `name` by hand. A runner's result comes only from the
    /// platform's fenced run, so posting it would overwrite that run; informational checks
    /// (neither required nor a runner) are open to any `check` scope.
    pub fn may_post(&self, name: &str, principal: &str, owner: bool) -> Result<()> {
        let allowed = if self.runners.contains_key(name) {
            false
        } else if !self.required_checks.iter().any(|c| c == name) {
            true
        } else {
            match self.check_posters.get(name) {
                Some(posters) => posters
                    .iter()
                    .any(|p| p == principal || (owner && p == "owner")),
                None => owner,
            }
        };
        if allowed {
            Ok(())
        } else {
            Err(Error::new(
                "FORBIDDEN",
                format!("Policy does not let this caller post the {name} check"),
            ))
        }
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
