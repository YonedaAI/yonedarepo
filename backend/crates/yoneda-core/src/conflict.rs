//! Typed evidence for candidate refreshes after the canonical Git head moves.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TrustedPathEvidence {
    pub base_commit: String,
    pub observed_head: String,
    pub candidate_commit: String,
    pub declared_paths: Vec<String>,
    pub captured_paths: Vec<String>,
    pub intervening_paths: Vec<String>,
    pub overlapping_paths: Vec<String>,
}

impl TrustedPathEvidence {
    /// Validate evidence returned by the trusted Git adapter against the requested revisions.
    pub fn validate(&self, base: &str, head: &str, candidate: &str) -> Result<()> {
        if self.base_commit != base
            || self.observed_head != head
            || self.candidate_commit != candidate
            || self.declared_paths.is_empty()
            || self.captured_paths.is_empty()
        {
            return Err(invalid(
                "Git path evidence does not match the reserved refresh",
            ));
        }
        for paths in [
            &self.declared_paths,
            &self.captured_paths,
            &self.intervening_paths,
            &self.overlapping_paths,
        ] {
            let unique: BTreeSet<_> = paths.iter().collect();
            if unique.len() != paths.len() {
                return Err(invalid("Git path evidence contains duplicates"));
            }
            for path in paths {
                crate::validate_path(path)?;
            }
        }
        let captured: BTreeSet<_> = self.captured_paths.iter().collect();
        if captured.iter().any(|captured| {
            !self.declared_paths.iter().any(|path| {
                **captured == path.as_str() || (path.ends_with('/') && captured.starts_with(path))
            })
        }) {
            return Err(invalid(
                "Declared paths do not describe captured source evidence",
            ));
        }
        let expected: BTreeSet<_> = self
            .captured_paths
            .iter()
            .filter(|path| self.intervening_paths.contains(path))
            .cloned()
            .collect();
        if expected.iter().cloned().collect::<Vec<_>>() != self.overlapping_paths {
            return Err(invalid(
                "Overlapping paths differ from the trusted path intersection",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ConflictRecord {
    pub id: String,
    pub repository_id: String,
    pub request_id: String,
    pub candidate_id: String,
    pub expected_version: i64,
    pub head_commit: String,
    pub candidate_base: String,
    pub status: ConflictStatus,
    pub evidence: TrustedPathEvidence,
    pub merge_commit: Option<String>,
    pub merge_workspace_commit: Option<String>,
    pub conflict_paths: Vec<String>,
    pub resolver_run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictStatus {
    Refreshing,
    Clean,
    Unresolved,
    Resolved,
    Stale,
    Failed,
}

fn invalid(message: &str) -> Error {
    Error::new("INVALID_CONFLICT_EVIDENCE", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence() -> TrustedPathEvidence {
        TrustedPathEvidence {
            base_commit: "a".repeat(40),
            observed_head: "b".repeat(40),
            candidate_commit: "c".repeat(40),
            declared_paths: vec!["src/change.rs".into()],
            captured_paths: vec!["src/change.rs".into()],
            intervening_paths: vec!["src/change.rs".into(), "README.md".into()],
            overlapping_paths: vec!["src/change.rs".into()],
        }
    }

    #[test]
    fn trusted_evidence_recomputes_overlap_and_scope() {
        assert!(
            evidence()
                .validate(&"a".repeat(40), &"b".repeat(40), &"c".repeat(40))
                .is_ok()
        );
        let mut forged = evidence();
        forged.overlapping_paths.clear();
        assert_eq!(
            forged
                .validate(&"a".repeat(40), &"b".repeat(40), &"c".repeat(40))
                .unwrap_err()
                .code,
            "INVALID_CONFLICT_EVIDENCE"
        );
        let mut out_of_scope = evidence();
        out_of_scope.captured_paths = vec!["private.txt".into()];
        assert!(
            out_of_scope
                .validate(&"a".repeat(40), &"b".repeat(40), &"c".repeat(40))
                .is_err()
        );
    }
}
