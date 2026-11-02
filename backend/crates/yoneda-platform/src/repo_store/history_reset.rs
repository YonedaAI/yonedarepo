//! A re-import (`repo-reimport.ts`): history goes, the repository stays. Its name, settings,
//! members, tokens, hooks, sessions, memories and what it withholds are not history: a clone
//! brings the same commit ids back under them. Everything else goes a batch per transaction,
//! as an erase does, so what a clone needs empty cannot outlive it, and a table added later
//! goes too unless it is named here. Each step is one transaction, and nothing records
//! progress beyond the rows left, so a repeat carries on. `repo_store_audit` is what finds the
//! repositories that need one: an older import kept history only in the object store that
//! has gone, as did a commit too large to stage.
use super::erase::{combiner_refs, wipe};
use super::rows::Settings;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::Result;

/// Tables a re-import keeps: what the repository is, beside what it holds.
const KEPT: [&str; 22] = [
    "members",
    "tokens",
    "hooks",
    "hook_attempts",
    "hook_cursor",
    "hook_outbox",
    "policy_history",
    "lfs_objects",
    "lfs_orphans",
    "lfs_quota",
    "lfs_sweep",
    "memories",
    "memory_anchors",
    "memory_retirements",
    "memory_text",
    "sessions",
    "session_text",
    "context_deliveries",
    "symbol_contracts",
    "quarantine",
    "break_glass",
    "forks",
];

/// `repo_import_reset {object_store?}`: one batch of history gone. Answers `done`, and `refs`:
/// the refs whose combiners the adapter clears, while they are still named. The last step
/// names the store the clone fills.
pub(super) fn step<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let refs = combiner_refs(db)?;
    let spent = wipe::batch_of(db, |table| !KEPT.contains(&table))?;
    if spent.finished {
        wipe::reset_indexes(db)?;
        // A repository that has not run migration 0046 has no total to clear.
        if settings.git_bytes.is_some() {
            db.query(
                "UPDATE repo_settings SET git_bytes=0 WHERE id='repository'",
                &[],
            )?;
        }
        if let Some(store) = c["object_store"].as_str() {
            db.query(
                "UPDATE repo_settings SET object_store=? WHERE id='repository'",
                &[json!(store)],
            )?;
        }
    }
    Ok(json!({ "done": spent.finished, "rows": spent.rows, "refs": refs }))
}

fn count<S: SqlStore>(db: &S, sql: &str) -> Result<u64> {
    let rows = db.query(sql, &[])?;
    Ok(rows.first().and_then(|r| r["n"].as_u64()).unwrap_or(0))
}

/// `repo_store_audit`: what this repository's history depended on. `imported_commits`: recorded
/// by an older import, whose objects stayed in the object store. `store_commits`: too large to
/// stage, so pushed whole to the object store, and in R2 only in part. `head`: main's commit and
/// tree, for the adapter to read back.
pub(super) fn audit<S: SqlStore>(db: &S, settings: &Settings) -> Result<Value> {
    let head = db.query(
        "SELECT c.id,c.tree FROM refs r JOIN commits c ON c.id=r.commit_id WHERE r.name='refs/heads/main'",
        &[],
    )?;
    Ok(json!({
        "name": settings.name,
        "object_store": settings.object_store,
        "commits": count(db, "SELECT COUNT(*) AS n FROM commits")?,
        "imported_commits": count(db, "SELECT COUNT(*) AS n FROM commits WHERE origin='import'")?,
        "store_commits": count(db, "SELECT COUNT(*) AS n FROM commits WHERE origin='platform' AND hidden_ref=1")?,
        "head": head.first(),
    }))
}
