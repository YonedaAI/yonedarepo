//! Agent-layer contracts: runs, teams, providers, budgets, guided demo, evaluation and the
//! per-attempt source workspace. The source platform (`yoneda-platform`) never depends on
//! this crate; it sees agents only as API principals.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
pub use yoneda_core::{Error, Result, digest, fingerprint, hex, validate_path};

pub mod adaptive_team;
pub mod agents;
pub mod autonomy;
pub mod build;
pub mod comparison;
pub mod conflict;
pub mod conflict_capture;
pub mod context;
pub mod context_study;
pub mod context_usage;
pub mod guided;
pub mod model_budget;
pub mod provider_routing;
pub mod providers;
pub mod resolver_scope;
pub mod retry;
mod source;
pub mod source_changeset;
pub mod source_workspace;
pub mod team;
/// Remote MCP tool contracts shared with the Worker transport.
pub const REMOTE_MCP_TOOLS: &str = include_str!("mcp_remote_tools.json");
pub use source::{FileEntry, Workspace};
pub const MAX_WORKSPACE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_FILES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Revision {
    pub repository: String,
    pub commit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Policy {
    pub version: String,
    pub suite: String,
    pub environment: String,
    pub required_checks: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<build::BuildProfile>,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            version: "retry-v2".into(),
            suite: "retry-contract-v2".into(),
            environment: "rust-1.94.0-evaluator-v2".into(),
            required_checks: vec!["build".into(), "behavior".into()],
            build: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Check {
    pub name: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Evaluation {
    pub id: String,
    pub candidate: String,
    pub revision: Revision,
    pub policy: String,
    pub suite: String,
    pub environment: String,
    pub checks: Vec<Check>,
    pub evidence: String,
}

pub fn validate_workspace(files: &Workspace) -> Result<()> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(Error::new(
            "WORKSPACE_LIMIT",
            "Workspace must contain 1–500 regular files",
        ));
    }
    let mut size = 0usize;
    for (path, entry) in files {
        validate_path(path)?;
        size = size.saturating_add(entry.bytes()?.len());
        if size > MAX_WORKSPACE_BYTES {
            return Err(Error::new("WORKSPACE_LIMIT", "Workspace exceeds 8 MiB"));
        }
    }
    for path in files.keys() {
        let mut parts = path.split('/').collect::<Vec<_>>();
        parts.pop();
        while !parts.is_empty() {
            if files.contains_key(&parts.join("/")) {
                return Err(Error::new("UNSAFE_PATH", "File is also a parent directory"));
            }
            parts.pop();
        }
    }
    Ok(())
}
pub fn validate_evaluation(
    e: &Evaluation,
    candidate: &str,
    revision: &Revision,
    policy: &Policy,
) -> Result<()> {
    validate_evaluation_binding(e, candidate, revision, policy)?;
    validate_required_checks(e, policy)
}

/// The evaluation is bound to the exact candidate, revision, policy and evidence object,
/// whatever its check outcomes.
pub fn validate_evaluation_binding(
    e: &Evaluation,
    candidate: &str,
    revision: &Revision,
    policy: &Policy,
) -> Result<()> {
    if e.candidate != candidate
        || &e.revision != revision
        || e.policy != policy.version
        || e.suite != policy.suite
        || e.environment != policy.environment
    {
        return Err(Error::new(
            "EVIDENCE_MISMATCH",
            "Evaluation is not bound to the exact candidate, policy, suite and environment",
        ));
    }
    if e.evidence.len() != 64 || !e.evidence.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::new(
            "EVIDENCE_MISMATCH",
            "Evaluation requires a SHA-256 evidence object",
        ));
    }
    Ok(())
}

/// Every required check must be present exactly once and pass.
pub fn validate_required_checks(e: &Evaluation, policy: &Policy) -> Result<()> {
    for required in &policy.required_checks {
        let matching: Vec<_> = e.checks.iter().filter(|c| &c.name == required).collect();
        if matching.len() != 1 || matching[0].status != "pass" {
            return Err(Error::new(
                "CHECKS_FAILED",
                format!("Required check {required} must pass exactly once"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_checks_and_exact_source_identity_gate_acceptance() {
        let revision = Revision {
            repository: "candidate-fork".into(),
            commit: "a".repeat(40),
        };
        let policy = Policy::default();
        let mut evaluation = Evaluation {
            id: "ev".into(),
            candidate: "candidate".into(),
            revision: revision.clone(),
            policy: policy.version.clone(),
            suite: policy.suite.clone(),
            environment: policy.environment.clone(),
            checks: vec![
                Check {
                    name: "build".into(),
                    status: "pass".into(),
                    detail: "".into(),
                },
                Check {
                    name: "behavior".into(),
                    status: "pass".into(),
                    detail: "".into(),
                },
            ],
            evidence: "b".repeat(64),
        };
        assert!(validate_evaluation(&evaluation, "candidate", &revision, &policy).is_ok());
        evaluation.checks[1].status = "skip".into();
        assert!(validate_evaluation(&evaluation, "candidate", &revision, &policy).is_err());
        evaluation.checks[1].status = "pass".into();
        evaluation.revision.commit = "c".repeat(40);
        assert!(validate_evaluation(&evaluation, "candidate", &revision, &policy).is_err());
    }
}
