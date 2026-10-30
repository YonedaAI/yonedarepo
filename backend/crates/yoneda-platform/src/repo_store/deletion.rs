//! Repository deletion: the owner names the repository to confirm, and the authority
//! becomes a tombstone. Every later operation answers GONE, its repository tokens are
//! revoked, and the adapter purges the object store asynchronously (the platform purger
//! asks for the store of record through `repo_purge_target`). Nothing is erased here, so
//! the deletion commits in one transaction with no I/O. Hooks subscribed to `repo` get one
//! `repo.deleted` payload, delivered from the tombstone by the hooks job.
use super::auth::Actor;
use super::hook_events::{Event, enqueue};
use super::hooks;
use super::op::{RepoOp, StoreOp};
use super::rows::Settings;
use crate::storage::{SqlStore, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// The refusal for every operation on a deleted repository.
pub fn gone() -> Error {
    Error::new("GONE", "Repository was deleted")
}

/// Whether `op` still runs on a tombstone: the (idempotent) delete, the purge read, and the
/// delivery of hook payloads already queued (`repo.deleted` among them).
pub fn allowed_when_deleted(op: StoreOp) -> bool {
    matches!(
        op,
        StoreOp::Repo(
            RepoOp::Delete | RepoOp::PurgeTarget | RepoOp::HookClaim | RepoOp::HookSettle
        )
    )
}

/// On a tombstone, hook delivery belongs to the platform's hooks job alone: anyone else is
/// answered GONE, as for every other operation.
pub fn tombstone_caller(op: StoreOp, actor: &Actor, settings: &Settings) -> Result<()> {
    let delivery = matches!(op, StoreOp::Repo(RepoOp::HookClaim | RepoOp::HookSettle));
    if settings.deleted_at.is_some() && delivery && !actor.can("hooks") {
        return Err(gone());
    }
    Ok(())
}

/// Queues `repo.deleted` for every active hook subscribed to `repo`; answers their ids (the
/// adapter sends their delivery jobs). Identifiers only: no name, message or contents.
fn notify_deleted<S: SqlStore>(db: &S, actor: &Actor, now: i64) -> Result<Vec<Value>> {
    let event = Event {
        name: "repo.deleted",
        version: None,
        at_ms: now,
        fields: [
            ("action".to_owned(), json!("deleted")),
            ("actor".to_owned(), json!(actor.principal)),
        ]
        .into_iter()
        .collect(),
        paths: Vec::new(),
        message: None,
    };
    let mut ids = Vec::new();
    for hook in hooks::active(db)?
        .into_iter()
        .filter(|h| h.wants(event.name))
    {
        enqueue(db, &hook, &event)?;
        ids.push(json!(hook.id));
    }
    Ok(ids)
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
    let answer = |already: bool, hooks: Vec<Value>| {
        json!({
            "deleted": true, "already": already, "name": settings.name,
            "object_store": settings.object_store,
            "parent": settings.parent.as_ref().map(|(repo, _)| repo),
            "hooks": hooks,
        })
    };
    if settings.deleted_at.is_some() {
        // A repeated delete re-sends whatever is still waiting (a lost delivery job).
        let pending = db
            .query(
                "SELECT DISTINCT hook_id AS id FROM hook_outbox ORDER BY hook_id",
                &[],
            )?
            .into_iter()
            .map(|r| r["id"].clone())
            .collect();
        return Ok(answer(true, pending));
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
    let hooks = notify_deleted(db, actor, now)?;
    Ok(answer(false, hooks))
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
