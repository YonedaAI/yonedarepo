//! Erasing a deleted repository (`repo-erase.ts`, behind `REPO_ERASE`). The tombstone keeps
//! answering GONE; everything else in the database goes, a batch per transaction, because
//! one large delete resets the object for minutes (spike, 2026-10-31).
//!
//! The job asks `repo_erase_plan` when it may start: never while a fork is left, as forks
//! read this repository's objects, and not before hooks have their `repo.deleted`, which is
//! delivered from these tables. A hook switched off, or one still undelivered `GIVE_UP_MS`
//! after the deletion, is given up on. The plan also names the refs whose combiners the job
//! clears, so the job does that before the rows naming them go. Then `repo_erase_step` runs
//! until it answers `done`. Each step is one transaction and nothing records progress
//! beyond the rows left, so a crash loses one step and the next job carries on. The last
//! step scrubs `repo_settings`, leaving a row an older binary still reads as a tombstone.
use super::forks;
use super::rows::Settings;
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub(crate) mod wipe;

/// `repo_settings.object_store` of an erased repository (no store is named this): the
/// marker needs no migration, and the store's name goes with it.
pub(super) const ERASED_STORE: &str = "erased";
/// What the scrubbed row holds as its policy: it must still parse.
const NO_POLICY: &str = r#"{"required_checks":[],"approvals":0}"#;
/// How long undelivered hooks hold the erase back (a failing endpoint is switched off well
/// before this: 50 failures take about 11 hours of backoff).
pub(crate) const GIVE_UP_MS: i64 = 24 * 60 * 60 * 1000;
/// Rows one transaction deletes at most. Full-text triggers fire for most of them.
pub(crate) const ROW_BUDGET: u32 = 2_000;
/// Bytes of values one transaction deletes, give or take its last row: the spike deleted
/// 19 MB in a transaction safely and 950 MB not.
pub(crate) const BYTE_BUDGET: u32 = 8 * 1024 * 1024;
/// Most refs one plan names: their combiners each cost the job a call.
const MAX_REFS: u32 = 512;

/// Hooks with payloads left to send, the erase being held back for them: none once
/// `deleted_at` is `GIVE_UP_MS` old.
fn awaited<S: SqlStore>(db: &S, c: &Value, deleted_at: i64) -> Result<Vec<Value>> {
    if number(c, "now")? >= deleted_at.saturating_add(GIVE_UP_MS) {
        return Ok(Vec::new());
    }
    Ok(db
        .query(
            "SELECT DISTINCT o.hook_id AS id FROM hook_outbox o JOIN hooks h ON h.id=o.hook_id WHERE h.active=1 ORDER BY o.hook_id",
            &[],
        )?
        .into_iter()
        .map(|r| r["id"].clone())
        .collect())
}

/// The refs that may have a combiner: branches, and every ref ever queued for landing.
fn combiner_refs<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    Ok(db
        .query(
            &format!(
                "SELECT name FROM refs WHERE name LIKE 'refs/heads/%' UNION SELECT refname FROM land_queue ORDER BY 1 LIMIT {MAX_REFS}"
            ),
            &[],
        )?
        .into_iter()
        .map(|r| r["name"].clone())
        .collect())
}

/// `repo_erase_plan`: whether the repository can be erased now. `live`, `erased`, or the
/// tombstone's size and store, with `forks` (never), `wait_ms` and `hooks` (not yet, the
/// hooks being those to deliver), or `refs` (go).
pub(super) fn plan<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let db_bytes = db.database_size()?;
    let Some(deleted_at) = settings.deleted_at else {
        return Ok(json!({ "live": true, "db_bytes": db_bytes }));
    };
    if settings.erased() {
        return Ok(json!({ "erased": true, "db_bytes": db_bytes }));
    }
    let mut answer = json!({
        "deleted_at": deleted_at, "db_bytes": db_bytes, "object_store": settings.object_store,
    });
    let forks = forks::count(db)?;
    if forks > 0 {
        answer["forks"] = json!(forks);
        return Ok(answer);
    }
    let hooks = awaited(db, c, deleted_at)?;
    if hooks.is_empty() {
        answer["refs"] = json!(combiner_refs(db)?);
    } else {
        answer["hooks"] = json!(hooks);
        answer["wait_ms"] = json!(deleted_at + GIVE_UP_MS - number(c, "now")?);
    }
    Ok(answer)
}

/// `repo_erase_step`: one batch, refused while the plan would say to wait. Answers what it
/// deleted and, once nothing is left, `done`.
pub(super) fn step<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let Some(deleted_at) = settings.deleted_at else {
        return Err(Error::new("NOT_FOUND", "Repository is not deleted"));
    };
    if settings.erased() {
        return Ok(json!({ "done": true, "rows": 0, "bytes": 0 }));
    }
    if forks::count(db)? > 0 {
        return Err(Error::new("CONFLICT", "A fork still reads this repository"));
    }
    if !awaited(db, c, deleted_at)?.is_empty() {
        return Err(Error::new("CONFLICT", "Hooks are still being delivered"));
    }
    let spent = wipe::batch(db)?;
    if spent.finished {
        wipe::reset_indexes(db)?;
        scrub(db)?;
    }
    Ok(json!({
        "done": spent.finished, "rows": spent.rows, "bytes": spent.bytes,
        "db_bytes": db.database_size()?,
    }))
}

/// What the tombstone keeps: the row, its deletion time, and values that still parse.
fn scrub<S: SqlStore>(db: &S) -> Result<()> {
    db.query(
        "UPDATE repo_settings SET name='',workspace='',owner='',object_store=?,policy=?,policy_digest='',created_at=0,parent=NULL,parent_version=NULL,visibility='private' WHERE id='repository'",
        &[json!(ERASED_STORE), json!(NO_POLICY)],
    )?;
    Ok(())
}
