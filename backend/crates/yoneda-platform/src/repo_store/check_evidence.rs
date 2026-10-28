//! What a check verdict's evidence must name: the run's exact commit and tree, and for a
//! command check the digest of the file set its container ran on. The adapter writes these
//! when it ships the files; the authority checks them before recording the verdict, so a
//! result can never be attributed to a tree it did not run against.
use super::rows::Runner;
use serde_json::Value;
use yoneda_core::{Error, Result, git_object::ObjectId};

/// Refuses `evidence` of a pass or fail that does not name `commit` and `tree` (and, for a
/// command runner, a `files_sha256` digest).
pub(super) fn ran_on(
    evidence: &Value,
    commit: &ObjectId,
    tree: &ObjectId,
    runner: &Runner,
) -> Result<()> {
    let names = |key: &str, id: &ObjectId| evidence[key].as_str() == Some(id.hex().as_str());
    let digest = evidence["files_sha256"].as_str().is_some_and(|d| {
        d.len() == 64 && d.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    });
    let files = matches!(runner, Runner::Model(_)) || digest;
    if names("commit", commit) && names("tree", tree) && files {
        return Ok(());
    }
    Err(Error::new(
        "EVIDENCE_MISMATCH",
        format!(
            "Check evidence must name commit {commit}, tree {tree} and the checked files' digest"
        ),
    ))
}
