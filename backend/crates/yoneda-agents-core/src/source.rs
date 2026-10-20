//! Binary-safe source manifest shared by Artifacts, capture and clean execution.
use crate::{Error, Result};
use base64::{Engine, engine::general_purpose::STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct FileEntry {
    pub content: String,
    #[serde(default)]
    pub executable: bool,
    /// Absent means UTF-8 for compatibility with previously captured manifests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
}
impl FileEntry {
    pub fn from_bytes(bytes: Vec<u8>, executable: bool) -> Self {
        match String::from_utf8(bytes) {
            Ok(content) => Self {
                content,
                executable,
                encoding: None,
            },
            Err(error) => Self {
                content: STANDARD.encode(error.as_bytes()),
                executable,
                encoding: Some("base64".into()),
            },
        }
    }
    pub fn bytes(&self) -> Result<Vec<u8>> {
        if self.content.len() > crate::MAX_WORKSPACE_BYTES * 4 / 3 + 4 {
            return Err(Error::new(
                "WORKSPACE_LIMIT",
                "Encoded file exceeds source limit",
            ));
        }
        match self.encoding.as_deref() {
            None => Ok(self.content.as_bytes().to_vec()),
            Some("base64") => STANDARD
                .decode(&self.content)
                .map_err(|_| Error::new("ENCODING", "Invalid base64 source file")),
            Some(_) => Err(Error::new("ENCODING", "Unsupported source encoding")),
        }
    }
}
pub type Workspace = BTreeMap<String, FileEntry>;
