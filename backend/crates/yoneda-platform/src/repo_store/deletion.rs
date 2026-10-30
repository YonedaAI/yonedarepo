//! Repository deletion: the owner names the repository to confirm, and the authority
//! becomes a tombstone. Every later operation answers GONE, its repository tokens are
//! revoked, and the adapter purges the object store asynchronously (the platform purger
//! asks for the store of record through `repo_purge_target`). Nothing is erased here, so
//! the deletion commits in one transaction with no I/O.
use super::auth::Actor;
use super::op::{RepoOp, StoreOp};
use super::rows::Settings;
use crate::storage::{SqlStore, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// The refusal for every operation on a deleted repository.
pub fn gone() -> Error {
    Error::new("GONE", "Repository was deleted")
}

/// Whether `op` still runs on a tombstone: the (idempotent) delete and the purge read.
pub fn allowed_when_deleted(op: StoreOp) -> bool {
    matches!(op, StoreOp::Repo(RepoOp::Delete | RepoOp::PurgeTarget))
}

/// `repo_delete {confirm}`: the owner only (never an admin member), with the repository's
/// exact name.
pub fn delete<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    actor.require_repo_owner()?;
    if string(c, "confirm")? != settings.name {
        return Err(Error::new(
            "INVALID_INPUT",
            "confirm must be the repository's name",
        ));
    }
    let answer = |already: bool| {
        json!({
            "deleted": true, "already": already, "name": settings.name,
            "object_store": settings.object_store,
            "parent": settings.parent.as_ref().map(|(repo, _)| repo),
        })
    };
    if settings.deleted_at.is_some() {
        return Ok(answer(true));
    }
    // Forks read this repository's objects: they go first.
    let forks = super::forks::count(db)?;
    if forks > 0 {
        return Err(Error::new(
            "CONFLICT",
            format!("This repository has {forks} fork(s); delete them first"),
        ));
    }
    let now = number(c, "now")?;
    db.query(
        "UPDATE repo_settings SET deleted_at=? WHERE id='repository'",
        &[json!(now)],
    )?;
    db.query(
        "UPDATE tokens SET revoked_at=? WHERE revoked_at IS NULL",
        &[json!(now)],
    )?;
    Ok(answer(false))
}

/// `repo_purge_target`: the store a deleted repository's objects live in (purger only),
/// and an Artifacts mirror retired from it but not deleted yet (`retired_mirror`).
pub fn purge_target<S: SqlStore>(db: &S, actor: &Actor, settings: &Settings) -> Result<Value> {
    if !actor.can("system") {
        return Err(gone());
    }
    if settings.deleted_at.is_none() {
        return Err(Error::new("NOT_FOUND", "Repository is not deleted"));
    }
    let retired = db.query(
        "SELECT mirror FROM mirror_retirement WHERE state='switched'",
        &[],
    )?;
    Ok(
        json!({ "name": settings.name, "object_store": settings.object_store,
               "retired_mirror": retired.first().map(|r| r["mirror"].clone()) }),
    )
}
