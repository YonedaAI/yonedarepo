//! Repository deletion: the owner names the repository to confirm, and the authority
//! becomes a tombstone. Every later operation answers GONE, its repository tokens are
//! revoked, and the adapter purges the object store asynchronously (the platform purger
//! asks for the store of record through `repo_purge_target`). Nothing is erased here, so
//! the deletion commits in one transaction with no I/O. Hooks subscribed to `repo` get one
//! `repo.deleted` payload, delivered from the tombstone by the hooks job. The erase job
//! empties the tombstone afterwards (`erase`). With the undo window, the purge waits (`undo`).
use super::audit_outbox;
use super::auth::Actor;
use super::hook_events::{Event, enqueue};
use super::hooks;
use super::op::{QuarantineOp as Q, RepoOp, StoreOp};
use super::rows::Settings;
use super::undo;
use crate::storage::{SqlStore, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// The refusal for every operation on a deleted repository.
pub fn gone() -> Error {
    Error::new("GONE", "Repository was deleted")
}

/// Whether `op` still runs on a tombstone: the purge's and the erase's own ops, and until it
/// is erased, the (idempotent) delete, whose hold is whose (a hold may be placed on a tombstone
/// until it is purged), and the delivery of hook payloads and audit events already queued
/// (`repo.deleted` among them), and the owner's purge, which a repeat finishes (`undo`). Until a
/// purge reaches it, a restore (`undo`), and the quarantine job, whose
/// deadlines the undo window must not push back; it alone gets those (`_system`, set by the
/// adapter), before anyone is told who they are.
pub fn allowed_when_deleted(op: StoreOp, c: &Value, settings: &Settings) -> bool {
    match op {
        StoreOp::Repo(
            RepoOp::PurgeTarget | RepoOp::Purged | RepoOp::ErasePlan | RepoOp::EraseStep,
        ) => true,
        StoreOp::Repo(
            RepoOp::Delete
            | RepoOp::PurgeNow
            | RepoOp::HoldOwner
            | RepoOp::HookClaim
            | RepoOp::HookSettle
            | RepoOp::AuditPending
            | RepoOp::AuditDone
            | RepoOp::AuditSetAside,
        ) => !settings.erased(),
        StoreOp::Repo(RepoOp::Restore) => !settings.purge_started(),
        StoreOp::Repo(RepoOp::Status)
        | StoreOp::Quarantine(
            Q::Claim
            | Q::Purged
            | Q::MirrorClaim
            | Q::MirrorCopied
            | Q::MirrorSwitch
            | Q::MirrorRetired
            | Q::MirrorFailed,
        ) => c["_system"] == "quarantine" && !settings.purge_started(),
        _ => false,
    }
}

/// On a tombstone, hook delivery, audit events and the erase belong to their platform jobs
/// alone, and who owns it to the platform: anyone else is answered GONE, as for every other
/// operation. So is a restore, but for the owner's account and the platform reading what it
/// lists, and a purge asked for now, but for the owner's account: its token goes on to
/// `authorize`, which tells it a person must ask.
pub fn tombstone_caller(op: StoreOp, c: &Value, actor: &Actor, settings: &Settings) -> Result<()> {
    if settings.deleted_at.is_none() {
        return Ok(());
    }
    let job = match op {
        StoreOp::Repo(RepoOp::HookClaim | RepoOp::HookSettle) => Some("hooks"),
        StoreOp::Repo(RepoOp::AuditPending | RepoOp::AuditDone | RepoOp::AuditSetAside) => {
            Some("audit")
        }
        StoreOp::Repo(RepoOp::ErasePlan | RepoOp::EraseStep) => Some("erase"),
        StoreOp::Repo(RepoOp::HoldOwner | RepoOp::Purged) => Some("system"),
        StoreOp::Repo(RepoOp::Restore) if !(actor.can("system") && c["check"] == true) => {
            return if actor.repo_owner() {
                Ok(())
            } else {
                Err(gone())
            };
        }
        StoreOp::Repo(RepoOp::PurgeNow) if !actor.repo_owner() => return Err(gone()),
        _ => None,
    };
    if job.is_some_and(|scope| !actor.can(scope)) {
        return Err(gone());
    }
    Ok(())
}

/// Queues `event` for every active hook subscribed to `repo`; answers their ids (the adapter
/// sends their delivery jobs). Identifiers only: no name, message or contents.
pub(super) fn notify<S: SqlStore>(
    db: &S,
    event: &'static str,
    action: &str,
    actor: &str,
    now: i64,
    extra: Option<(&str, Value)>,
) -> Result<Vec<Value>> {
    let event = Event {
        name: event,
        version: None,
        at_ms: now,
        fields: [
            ("action".to_owned(), json!(action)),
            ("actor".to_owned(), json!(actor)),
        ]
        .into_iter()
        .chain(extra.map(|(k, v)| (k.to_owned(), v)))
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

/// `repo_delete {confirm}`: the owner only (never an admin member: `authorize`), with the
/// repository's exact name.
pub fn delete<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    if string(c, "confirm")? != settings.name {
        return Err(Error::new(
            "INVALID_INPUT",
            "confirm must be the repository's name",
        ));
    }
    let answer = |already: bool, hooks: Vec<Value>, deleted_at: i64| {
        let mut answer = undo::facts(c, settings, Some(deleted_at));
        answer["deleted"] = json!(true);
        answer["already"] = json!(already);
        answer["object_store"] = json!(settings.object_store);
        answer["hooks"] = json!(hooks);
        answer
    };
    if let Some(deleted_at) = settings.deleted_at {
        // A repeated delete re-sends whatever is still waiting (a lost delivery job).
        let pending = db
            .query(
                "SELECT DISTINCT hook_id AS id FROM hook_outbox WHERE hook_id<>? ORDER BY hook_id",
                &[json!(audit_outbox::OUTBOX)],
            )?
            .into_iter()
            .map(|r| r["id"].clone())
            .collect();
        return Ok(answer(true, pending, deleted_at));
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
    let told = undo::facts(c, settings, Some(now))["purge_at"].as_i64();
    let purge_at = told.map(|at| ("purge_at", json!(super::hooks::iso(at))));
    let hooks = notify(
        db,
        "repo.deleted",
        "deleted",
        &actor.principal,
        now,
        purge_at,
    )?;
    audit_outbox::record(db, c, "repo.deleted", &actor.principal, json!({}))?;
    Ok(answer(false, hooks, now))
}

/// `repo_purge_target`: the store a deleted repository's objects live in (purger only),
/// and an Artifacts mirror retired from it but not deleted yet (`retired_mirror`). Refused
/// until the undo window has passed; the first to pass ends it (`undo`).
pub fn purge_target<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &Settings,
) -> Result<Value> {
    if !actor.can("system") {
        return Err(gone());
    }
    if settings.deleted_at.is_none() {
        return Err(Error::new("NOT_FOUND", "Repository is not deleted"));
    }
    undo::require_due(c, settings)?;
    undo::start_purge(db, settings)?;
    let retired = db.query(
        "SELECT mirror FROM mirror_retirement WHERE state='switched'",
        &[],
    )?;
    Ok(
        json!({ "name": settings.name, "object_store": settings.object_store,
               "retired_mirror": retired.first().map(|r| r["mirror"].clone()) }),
    )
}
