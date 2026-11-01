//! A repository's two limits. Its size is its Git objects, which live in object storage: the
//! adapter sets `_size_guard` to the published cap when that guard is on, and the running
//! total in `repo_settings.git_bytes` (read with every command) refuses pushes and new commits
//! at it. Nothing here needs room above that cap, and no read is added to find the total. It
//! holds what was counted, not what the object store holds: nothing before migration 0046
//! and no history an import took through Artifacts, whose size nothing reports.
//!
//! Its history database grows with commits, landings, checks and sessions, however little
//! code they carry. Durable Object SQLite refuses writes at its limit, so the platform reads
//! the size here to watch it (`repo_storage`, `store_status`). SQLite has no per-table size here (no `dbstat`);
//! row counts are estimates from the highest rowid, one index lookup each however large the
//! table is, and deleting older rows does not lower them.
//!
//! The adapter sets `_storage_guard` to a size in bytes when the guard is on (never from
//! client input). From that size, ops that start new work answer `REPO_FULL`: a deny-list,
//! because everything else must keep running on a full repository. Work already accepted
//! finishes (projection, changeset records, hooks, adoption, compaction, queued landings),
//! as do reads that need it and whatever frees space or protects the repository (token
//! revocation, quarantine, deletes). A pending changeset would otherwise fail branch reads
//! (`rows::ref_value`) and hold compaction back (`maintenance::compaction`).
//!
//! New work also means anything a client can repeat that adds rows without a limit: a new
//! branch copies up to 5,000 `ref_chain` rows (about 1.2 MB), so 600 of them would otherwise
//! spend the room left above the limit. Moving or deleting a branch and resolving a comment
//! stay open: they are refused inside their ops, only when they would add (`refuse_if_full`).
use super::op::{MemoryOp as M, RepoOp as R, StoreOp};
use super::rows::Settings;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};
use yoneda_store::REPO_FULL_MESSAGE;

/// The authority's tables that grow with history.
pub(crate) const REPO_TABLES: &[&str] = &[
    "txlog",
    "txlog_paths",
    "commits",
    "commit_paths",
    "commit_objects",
    "commit_classes",
    "commit_symbols",
    "changesets",
    "landings",
    "land_queue",
    "staged_objects",
    "tree_cache",
    "checks",
    "check_runs",
    "reviews",
    "sessions",
    "changes",
    "change_comments",
    "memories",
    "context_deliveries",
    "hook_outbox",
    "hook_attempts",
    "tokens",
];

/// A commit shard's tables.
pub(crate) const SHARD_TABLES: &[&str] = &[
    "commits",
    "commit_paths",
    "commit_objects",
    "commit_classes",
    "commit_symbols",
    "staged_objects",
];

/// `{db_bytes, table_rows}`: the database's size and `tables`' row estimates.
pub(crate) fn usage<S: SqlStore>(db: &S, tables: &[&str]) -> Result<Value> {
    let estimates: Vec<String> = tables
        .iter()
        .map(|table| format!("(SELECT COALESCE(MAX(rowid),0) FROM {table}) AS {table}"))
        .collect();
    let rows = db.query(&format!("SELECT {}", estimates.join(",")), &[])?;
    Ok(json!({ "db_bytes": db.database_size()?, "table_rows": rows.first() }))
}

/// `repo_storage`: `usage`, and the size of the repository's Git objects.
pub(super) fn repo_usage<S: SqlStore>(db: &S, settings: &Settings) -> Result<Value> {
    let mut answer = usage(db, REPO_TABLES)?;
    answer["git_bytes"] = json!(settings.git_bytes);
    Ok(answer)
}

/// Ops that start new work, refused before they run. Landing is refused inside its ops
/// (`landing_refused`), where a repeat of an accepted landing still answers.
pub(super) fn refuses(op: StoreOp) -> bool {
    matches!(
        op,
        StoreOp::Repo(
            R::PrepareCommit
                | R::BeginCommit
                | R::RecordCommit
                | R::RecordPushed
                | R::Import
                | R::RecordImported
                | R::RecordImportedBatch
                | R::TagCreate
                | R::ChangeCreate
                | R::ReleaseCreate
                | R::SessionRecord
                | R::FlightPlan
        ) | StoreOp::Memory(M::Add)
    )
}

/// Ops that add Git objects without a pack to count; a push is refused at `repo_git_access`,
/// before it stores anything.
pub(super) fn adds_objects(op: StoreOp) -> bool {
    matches!(op, StoreOp::Repo(R::PrepareCommit | R::BeginCommit))
}

/// Whether the repository's Git objects have reached the guard's size. `git_bytes` is absent
/// until migration 0046 has run, and then nothing counts and nothing is refused.
pub(super) fn over_size(settings: &Settings, c: &Value) -> bool {
    matches!(
        (settings.git_bytes, c["_size_guard"].as_u64()),
        (Some(bytes), Some(limit)) if bytes >= limit
    )
}

pub(crate) fn size_refusal() -> Error {
    Error::new(
        "REPO_SIZE_LIMIT",
        "This repository has reached its size limit. Pushes and new commits are refused; \
         reading, cloning and deleting still work. To keep going, start a new repository or \
         contact support.",
    )
}

/// `REPO_SIZE_LIMIT` when the guard is on and the repository's objects have reached it.
pub(super) fn refuse_if_over_size(settings: &Settings, c: &Value) -> Result<()> {
    if over_size(settings, c) {
        Err(size_refusal())
    } else {
        Ok(())
    }
}

/// Adds the `pack_bytes` the adapter stored to the repository's size: a push's pack, which is
/// what a `.git` folder holds, compressed, or the files of API commits (`repo_size_add`).
pub(super) fn add_pack<S: SqlStore>(db: &S, settings: &Settings, c: &Value) -> Result<()> {
    let bytes = c["pack_bytes"].as_u64().unwrap_or_default();
    if bytes > 0 && settings.git_bytes.is_some() {
        db.query(
            "UPDATE repo_settings SET git_bytes=git_bytes+? WHERE id='repository'",
            &[json!(bytes)],
        )?;
    }
    Ok(())
}

pub(super) fn full<S: SqlStore>(db: &S, c: &Value) -> Result<bool> {
    match c["_storage_guard"].as_u64() {
        Some(limit) => Ok(db.database_size()? >= limit),
        None => Ok(false),
    }
}

pub(crate) fn refusal() -> Error {
    Error::new("REPO_FULL", REPO_FULL_MESSAGE)
}

/// `REPO_FULL` when the guard is on and the database has reached its limit.
pub(crate) fn refuse_if_full<S: SqlStore>(db: &S, c: &Value) -> Result<()> {
    if full(db, c)? { Err(refusal()) } else { Ok(()) }
}

/// Whether a landing of `commit` on `refname`, not landed yet, is new work to refuse: a
/// ticket already queued for it was accepted and keeps its place.
pub(super) fn landing_refused<S: SqlStore>(
    db: &S,
    c: &Value,
    refname: &str,
    commit: &ObjectId,
) -> Result<bool> {
    if !full(db, c)? {
        return Ok(false);
    }
    let queued = db.query(
        "SELECT 1 AS x FROM land_queue WHERE refname=? AND commit_id=? AND status='pending'",
        &[json!(refname), json!(commit.hex())],
    )?;
    Ok(queued.is_empty())
}
