//! Parsing a commit request's changes: paths, modes, preconditions and content, within
//! the request size limits. A referenced blob must already belong to this repository.
//! Sent content is scanned for credentials here, the one place every commit path (REST,
//! MCP, helper, merges, codemods, symbol edits; authority or stateless) decodes it.
use super::super::rows::object_id;
use crate::secret_scan::SecretAllow;
use crate::storage::{SqlStore, bad, string};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::{FileMode, ObjectId},
};

const MAX_CHANGES: usize = 10_000;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 100 * 1024 * 1024;
pub(crate) enum Content {
    Bytes(Vec<u8>),
    /// A blob already in the object store (revert, cherry-pick): referenced, not re-sent.
    Known(ObjectId),
}

pub(crate) struct Change {
    pub(crate) path: String,
    pub(crate) target: Option<(FileMode, Content)>,
    /// Precondition on the parent: the path's current blob (`None`: absent).
    pub(crate) expect: Option<Option<ObjectId>>,
}

fn expectation(change: &Value) -> Result<Option<Option<ObjectId>>> {
    match change.get("expect") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(_) => Ok(Some(Some(object_id(change, "expect")?))),
    }
}

fn file_mode(change: &Value) -> Result<FileMode> {
    Ok(match change["type"].as_str() {
        Some("symlink") => FileMode::Symlink,
        Some("exec") => FileMode::Executable,
        Some("blob") | None if change["executable"] == true => FileMode::Executable,
        Some("blob") | None => FileMode::Blob,
        Some(_) => return Err(bad("Change type must be blob, exec or symlink")),
    })
}

/// `allow`: the policy's accepted false positives (none on the stateless path, whose
/// adapter falls back to the authority when a scan refuses).
pub(crate) fn changes(c: &Value, allow: &[SecretAllow]) -> Result<Vec<Change>> {
    let list = c["changes"]
        .as_array()
        .filter(|l| l.len() <= MAX_CHANGES)
        .filter(|l| {
            !l.is_empty()
                || c.get("merge_parent").is_some_and(|p| !p.is_null())
                || c["merge_parents"].as_array().is_some_and(|p| !p.is_empty())
        });
    let mut total = 0usize;
    list.ok_or_else(|| bad("Provide 1 to 10000 changes"))?
        .iter()
        .map(|change| {
            let path = string(change, "path")?;
            let expect = expectation(change)?;
            if change["delete"] == true {
                return Ok(Change {
                    path,
                    target: None,
                    expect,
                });
            }
            if change.get("blob").is_some() {
                let blob = Content::Known(object_id(change, "blob")?);
                return Ok(Change {
                    path,
                    target: Some((file_mode(change)?, blob)),
                    expect,
                });
            }
            // File content is bounded by the size limits below, not the short-field cap of
            // `string` (which also rejects the empty base64 of an empty file).
            let encoded = change["content_b64"]
                .as_str()
                .ok_or_else(|| bad("Missing content_b64"))?;
            if encoded.len() > MAX_FILE_BYTES / 3 * 4 + 4 {
                return Err(Error::new(
                    "TOO_LARGE",
                    "Change exceeds file or total size limit",
                ));
            }
            let content = STANDARD
                .decode(encoded)
                .map_err(|_| bad("content_b64 is not base64"))?;
            crate::secret_scan::scan(&path, &content, allow)?;
            total += content.len();
            if content.len() > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES {
                return Err(Error::new(
                    "TOO_LARGE",
                    "Change exceeds file or total size limit",
                ));
            }
            Ok(Change {
                path,
                target: Some((file_mode(change)?, Content::Bytes(content))),
                expect,
            })
        })
        .collect()
}

/// A referenced blob must already be in this repository's object store: it was written
/// by a recorded commit (or removed by one, so it existed in that commit's parent).
pub(crate) fn known_blob<S: SqlStore>(db: &S, id: &ObjectId) -> Result<()> {
    let found = db.query(
        "SELECT 1 AS found FROM commit_paths WHERE new_blob=? OR old_blob=? LIMIT 1",
        &[json!(id.hex()), json!(id.hex())],
    )?;
    if found.is_empty() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("Blob {id} is not in this repository"),
        ));
    }
    Ok(())
}
