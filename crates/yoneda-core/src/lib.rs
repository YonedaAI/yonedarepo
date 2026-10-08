use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const CONTRACT_VERSION: u32 = 1;
pub mod build;
pub mod context;
/// Remote MCP tool contracts shared with the Worker transport.
pub const REMOTE_MCP_TOOLS: &str = include_str!("mcp_remote_tools.json");
pub mod retry;
mod source;
pub use source::{FileEntry, Workspace};
pub const MAX_WORKSPACE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_FILES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, thiserror::Error)]
#[error("{code}: {message}")]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;

macro_rules! id_type {
    ($($name:ident),+) => {$ (
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema)]
        #[serde(transparent)]
        pub struct $name(pub String);
    )+};
}
id_type!(
    RepositoryId,
    RunId,
    ExecutionId,
    CandidateId,
    EvaluationId,
    DecisionId,
    ArtifactId
);

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

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GraphNode {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub author: String,
    pub recorded_at: i64,
    pub data: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub relation: String,
    pub evidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct Event {
    pub seq: i64,
    pub kind: String,
    pub at: i64,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct JobEnvelope {
    pub v: u32,
    pub repo_id: String,
    pub job_id: String,
    pub kind: String,
}

pub fn validate_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 512
        || path.starts_with('/')
        || path.contains(['\\', '\0', ':'])
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err(Error::new(
            "UNSAFE_PATH",
            format!("Unsupported source path: {path:?}"),
        ));
    }
    Ok(())
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
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
pub fn fingerprint(value: &Value) -> Result<String> {
    fn canonical(v: &Value) -> Result<Value> {
        Ok(match v {
            Value::Object(m) => {
                let ordered: BTreeMap<_, _> = m
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), canonical(v)?)))
                    .collect::<Result<_>>()?;
                serde_json::to_value(ordered).map_err(|e| Error::new("ENCODING", e.to_string()))?
            }
            Value::Array(a) => Value::Array(a.iter().map(canonical).collect::<Result<_>>()?),
            Value::Number(n) if n.is_f64() => {
                return Err(Error::new("ENCODING", "Fingerprints forbid floating point"));
            }
            _ => v.clone(),
        })
    }
    let mut bytes = b"yonedarepo:json:v1\0".to_vec();
    bytes.extend(
        serde_json::to_vec(&canonical(value)?)
            .map_err(|e| Error::new("ENCODING", e.to_string()))?,
    );
    Ok(digest(&bytes))
}
pub fn validate_evaluation(
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
    use serde_json::json;

    #[test]
    fn safe_paths_are_allowed_and_archive_escapes_are_rejected() {
        assert!(validate_path("src/retry.rs").is_ok());
        for path in [
            "../key",
            "/etc/passwd",
            "a/../../x",
            ".git/config",
            "a/.git/hooks/x",
            "a\\b",
            "a//b",
            "a/./b",
            "",
            "a\0b",
        ] {
            assert!(validate_path(path).is_err(), "{path:?}");
        }
    }
    #[test]
    fn evidence_hash_matches_standard_sha256() {
        assert_eq!(
            digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
    #[test]
    fn fingerprints_ignore_object_key_order_but_not_input_changes() {
        assert_eq!(
            fingerprint(&json!({"a":1,"b":2})).unwrap(),
            fingerprint(&json!({"b":2,"a":1})).unwrap()
        );
        assert_ne!(
            fingerprint(&json!({"a":1})).unwrap(),
            fingerprint(&json!({"a":2})).unwrap()
        );
        assert!(fingerprint(&json!({"score": 0.5})).is_err());
    }
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
