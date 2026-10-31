//! How much of its database a store uses. Durable Object SQLite refuses writes at its size
//! limit, so the platform reads the size here to watch it (`repo_storage`, `store_status`).
//! SQLite has no per-table size here (no `dbstat`); row counts are estimates from the
//! highest rowid, one index lookup each however large the table is, and deleting older rows
//! does not lower them.
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::Result;

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
