//! How much of its database a store uses, and the refusal of new work near the size limit.
//! Durable Object SQLite refuses writes at its limit, so the platform reads the size here to
//! watch it (`repo_storage`, `store_status`). SQLite has no per-table size here (no `dbstat`);
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
use super::op::{RepoOp as R, StoreOp};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

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
        )
    )
}

pub(super) fn full<S: SqlStore>(db: &S, c: &Value) -> Result<bool> {
    match c["_storage_guard"].as_u64() {
        Some(limit) => Ok(db.database_size()? >= limit),
        None => Ok(false),
    }
}

pub(crate) fn refusal() -> Error {
    Error::new(
        "REPO_FULL",
        "This repository's database is full: new commits and landings are refused, reads and \
         work already accepted continue",
    )
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
