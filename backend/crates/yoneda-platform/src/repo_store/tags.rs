//! Lightweight tags: a `refs/tags/*` ref is created once, at a recorded commit, and never
//! moves or disappears. Creation is logged as a `RefMove` like any branch move and is
//! projected to the object store like a protected branch. Annotated tag objects are not
//! stored; the Git paths refuse them before they reach here.
use super::branches::move_ref;
use super::rows::{self, object_id};
use crate::storage::string;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// `repo_tag_create {name, commit}`.
pub fn create<S: crate::storage::SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let refname = rows::tag_ref(&string(c, "name")?)?;
    check(db, c, &refname)?;
    create_at(db, c, &refname, principal)
}

/// Creates `refname` at `c.commit` (already checked); creating it again at the same
/// commit is a no-op.
pub(super) fn create_at<S: crate::storage::SqlStore>(
    db: &S,
    c: &Value,
    refname: &str,
    principal: &str,
) -> Result<Value> {
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    if rows::ref_value(db, refname)? == Some(commit.id) {
        return Ok(json!({ "ref": refname, "commit": commit.id, "already": true }));
    }
    let version = move_ref(db, c, refname, None, &commit, principal)?;
    Ok(json!({ "ref": refname, "commit": commit.id, "version": version }))
}

/// Refuses anything but creating `refname` at a recorded commit: no deletion, no expected
/// old value, and no tag that already names a different commit.
pub(super) fn check<S: crate::storage::SqlStore>(db: &S, c: &Value, refname: &str) -> Result<()> {
    if c.get("commit").is_none_or(Value::is_null) {
        return Err(immutable(format!("{refname} cannot be deleted")));
    }
    if c.get("expected").is_some_and(|e| !e.is_null()) {
        return Err(immutable(format!(
            "{refname} is created once (expected must be null) and never moves"
        )));
    }
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    match rows::ref_value(db, refname)? {
        Some(current) if current != commit.id => Err(already(refname, &current)),
        _ => Ok(()),
    }
}

/// The tag a batch update names, if it names one (`refs/tags/...` in full).
pub(super) fn in_update(update: &Value) -> Result<Option<String>> {
    match update["ref"].as_str() {
        Some(name) if rows::is_tag(name) => rows::tag_ref(name).map(Some),
        _ => Ok(None),
    }
}

/// Whether a `repo_branch_batch` creates a tag (it then needs the land scope too).
pub fn in_batch(c: &Value) -> bool {
    c["updates"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|u| u["ref"].as_str().is_some_and(rows::is_tag))
}

fn immutable(message: String) -> Error {
    Error::new("FORBIDDEN", format!("Tags are immutable: {message}"))
}

fn already(refname: &str, current: &ObjectId) -> Error {
    Error::new(
        "ALREADY_EXISTS",
        format!("{refname} already exists at {current}; tags are immutable"),
    )
}
