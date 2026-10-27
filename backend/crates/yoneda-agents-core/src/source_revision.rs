//! The frozen platform source a run starts from, as the adapter approved it.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The most files one candidate's changed-path list may name.
pub const MAX_FILES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SourceRevision {
    pub repository: String,
    pub commit: String,
    pub tree: String,
}
impl SourceRevision {
    pub fn validate(&self) -> Result<()> {
        if self.repository.is_empty()
            || self.repository.len() > 256
            || self.repository.chars().any(char::is_control)
        {
            return Err(invalid("Invalid bounded source identity"));
        }
        validate_hash(&self.commit)?;
        validate_hash(&self.tree)
    }
}

fn invalid(message: &str) -> Error {
    Error::new("INVALID_SOURCE", message)
}
fn validate_hash(value: &str) -> Result<()> {
    if ![40, 64].contains(&value.len())
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("Invalid lowercase source digest"));
    }
    Ok(())
}
