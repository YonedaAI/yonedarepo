//! Tags: a `refs/tags/*` ref is created once, at a recorded commit, and never moves or
//! disappears. Creation is logged as a `RefMove` like any branch move and is projected to
//! the object store like a protected branch. An annotated tag (`tag: {data_b64}` on the
//! update, or `message` here) keeps its ref at the commit and its tag object beside it
//! (`annotated`).
use super::annotated::{self, Annotation};
use super::branches::move_ref;
use super::rows::{self, object_id};
use crate::storage::{number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// `repo_tag_create {name, commit, message?, tagger?}`: with `message`, the platform
/// builds an annotated tag object.
pub fn create<S: crate::storage::SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let refname = rows::tag_ref(&string(c, "name")?)?;
    let mut c = c.clone();
    if let Some(data) = annotated::built(&c, &refname, principal)? {
        c["tag"] = json!({ "data_b64": data });
    }
    check(db, &c, &refname)?;
    create_at(db, &c, &refname, principal)
}

/// Creates `refname` at `c.commit` (already checked), with its tag object when annotated;
/// creating the same tag again is a no-op.
pub(super) fn create_at<S: crate::storage::SqlStore>(
    db: &S,
    c: &Value,
    refname: &str,
    principal: &str,
) -> Result<Value> {
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    let annotation = Annotation::of(c, &commit.id)?;
    let tag = annotation.as_ref().map(|a| a.id);
    if rows::ref_value(db, refname)? == Some(commit.id) {
        if annotated::tag_id(db, refname)? != tag {
            return Err(already(refname, &commit.id));
        }
        return Ok(json!({ "ref": refname, "commit": commit.id, "tag": tag, "already": true }));
    }
    let version = move_ref(db, c, refname, None, &commit, principal)?;
    if let Some(annotation) = annotation {
        annotation.store(db, refname, principal, number(c, "now")?)?;
    }
    Ok(json!({ "ref": refname, "commit": commit.id, "tag": tag, "version": version }))
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
    Annotation::of(c, &commit.id)?;
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
