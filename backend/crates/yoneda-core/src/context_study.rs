//! Frozen, explicitly configured controls for isolated context usefulness trials.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudyArm {
    SourceOnly,
    PlainNotes,
    Graph,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextStudy {
    pub id: String,
    pub case: String,
    pub arm: StudyArm,
    pub corpus: Vec<String>,
    #[serde(default)]
    pub records: Vec<Value>,
}

impl ContextStudy {
    pub fn validate(&self) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 80
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || !["website_update", "delegation", "local_continuation"].contains(&self.case.as_str())
            || self.corpus.is_empty()
            || self.corpus.len() > 50
            || self.corpus.iter().any(|id| id.is_empty() || id.len() > 256)
            || self.records.len() > 50
            || serde_json::to_vec(&self.records)
                .map_err(|e| Error::new("INVALID_INPUT", e.to_string()))?
                .len()
                > 96 * 1024
        {
            return Err(Error::new(
                "INVALID_INPUT",
                "Invalid isolated context study configuration",
            ));
        }
        Ok(())
    }

    /// Return only the information permitted in the initial model input.
    pub fn initial_context(&self) -> Value {
        match self.arm {
            StudyArm::PlainNotes => serde_json::json!({"plain_notes": self.records}),
            StudyArm::SourceOnly | StudyArm::Graph => serde_json::json!([]),
        }
    }
}
