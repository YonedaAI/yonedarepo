//! Metadata-only, attempt-bound source staging contracts; Git capture stays independent.
use crate::{Error, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
mod grant;
mod view;
pub use grant::*;
pub use view::*;
pub const TRANSPORT: &str = "api-source-v1";
pub const MAX_FILES: usize = 10_000;
pub const SCRATCH_PREFIXES: [&str; 4] = ["node_modules/", "target/", ".venv/", "__pycache__/"];
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_SOURCE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_UPLOAD_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_REQUESTS: usize = 4096;
pub const MAX_CHECKPOINTS: usize = 128;
pub fn invalid(message: &str) -> Error {
    Error::new("INVALID_SOURCE", message)
}
pub fn validate_hash(value: &str, lengths: &[usize]) -> Result<()> {
    if !lengths.contains(&value.len())
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid("Invalid lowercase source digest"));
    }
    Ok(())
}
pub fn validate_id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(invalid("Invalid bounded source identity"));
    }
    Ok(())
}
pub fn workspace_id(repo_id: &str, job_id: &str, epoch: i64, view_digest: &str) -> Result<String> {
    validate_id(repo_id)?;
    validate_id(job_id)?;
    validate_hash(view_digest, &[64])?;
    if epoch < 1 {
        return Err(invalid("Invalid attempt epoch"));
    }
    Ok(format!(
        "source-workspace:{}",
        crate::fingerprint(
            &serde_json::json!({"repo_id":repo_id,"job_id":job_id,"epoch":epoch,"view_digest":view_digest})
        )?
    ))
}
pub fn view_digest(view: &SourceView, overrides: &[BaselineOverride]) -> Result<String> {
    crate::fingerprint(&serde_json::json!({"view":view,"baseline_overrides":overrides}))
}
