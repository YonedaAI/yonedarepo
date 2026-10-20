//! Access evidence describes delivery, never whether a model understood or used a record.
use crate::{Check, Error, Result, Revision};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const MAX_ACCESS_TARGETS: usize = 2000;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AccessStage {
    Assigned,
    Returned,
    Opened,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AccessTarget {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}
impl AccessTarget {
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() || self.id.len() > 512 || self.id.contains('\0') {
            return Err(Error::new("INVALID_INPUT", "Invalid context access target"));
        }
        if self.digest.as_ref().is_some_and(|digest| {
            digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit())
        }) {
            return Err(Error::new("INVALID_INPUT", "Invalid context access digest"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceAuthority {
    Assertion,
    CapturedRevision,
    CheckedRevision,
    RecordedDecision,
    SourceRevision,
    PlatformRecord,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct EvidenceTarget {
    pub id: String,
    pub digest: Option<String>,
    pub kind: String,
    pub label: String,
    pub authority: EvidenceAuthority,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relation: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AccessEntry {
    pub seq: i64,
    pub call_id: String,
    pub at: i64,
    pub tool: String,
    pub stage: AccessStage,
    pub run_id: Option<String>,
    pub execution_id: Option<String>,
    pub job_id: Option<String>,
    pub epoch: Option<i64>,
    pub session_id: Option<String>,
    pub targets: Vec<EvidenceTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_digest: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct AssignedEntry {
    pub execution_id: String,
    pub stage: AccessStage,
    pub targets: Vec<EvidenceTarget>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CheckedRevision {
    pub candidate_id: String,
    pub execution_id: String,
    pub revision: Revision,
    pub evaluation_id: String,
    pub evidence: String,
    pub policy: String,
    pub checks: Vec<Check>,
    pub authority: EvidenceAuthority,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CitationCandidate {
    pub id: String,
    pub revision: Revision,
    pub capture_job_id: String,
    pub evaluation: Option<CheckedRevision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_kind: Option<CaptureKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_handoff: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind {
    TaskContribution,
    Integration,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CitationEntry {
    pub record_id: String,
    pub execution_id: String,
    /// Sequence from the authoritative assertion event stream, not the receipt stream.
    pub seq: Option<i64>,
    pub at: i64,
    pub epoch: Option<i64>,
    pub authority: EvidenceAuthority,
    pub targets: Vec<EvidenceTarget>,
    pub candidates: Vec<CitationCandidate>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UsageCounts {
    /// Distinct target IDs in the entire run, irrespective of the page or filters.
    pub assigned: u64,
    pub returned: u64,
    pub opened: u64,
    pub cited: u64,
    /// Independently evaluated exact candidate revisions, not verified assertions.
    pub checked: u64,
    pub read_calls: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UsageCoverage {
    pub status: String,
    pub reason: String,
    pub activated_at: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UsagePage {
    pub version: u32,
    pub run_id: Option<String>,
    pub coverage: UsageCoverage,
    pub counts: UsageCounts,
    pub assigned: Vec<AssignedEntry>,
    pub entries: Vec<AccessEntry>,
    pub citations: Vec<CitationEntry>,
    pub checked: Vec<CheckedRevision>,
    pub next_cursor: i64,
    pub has_more: bool,
    pub citations_truncated: bool,
}
