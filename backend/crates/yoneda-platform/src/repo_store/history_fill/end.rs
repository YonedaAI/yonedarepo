//! A fill that cannot finish ends where it reached, so that a failure to record history
//! never costs the repository: its generations and chain move down to start at 1, which is
//! what a capped import holds (its oldest commit keeps parents no row holds, and the walks
//! stop there), and it stops refusing work (`filling` answers none). No table says "capped",
//! so what the page and every read of history then say is kept as a note on the oldest
//! commit in `repairs`, under a name no check can have.
use super::{MAIN, filling};
use crate::storage::{SqlStore, number, string};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use yoneda_core::Result;

/// `repairs.check_name` of the note (a check's name has no space: `check_name`).
const NOTE: &str = "history import";
const REASON_CHARS: usize = 300;

/// An imported history that ended early: how much of it is here, and why.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct HistoryStopped {
    pub recorded: u64,
    pub total: u64,
    pub reason: String,
}

/// What ended this repository's history early, if anything did.
pub fn stopped<S: SqlStore>(db: &S) -> Result<Option<HistoryStopped>> {
    let rows = db.query(
        "SELECT error FROM repairs WHERE check_name=? LIMIT 1",
        &[json!(NOTE)],
    )?;
    Ok(rows
        .first()
        .and_then(|row| serde_json::from_str(row["error"].as_str()?).ok()))
}

/// Main's head while it is the imported head of a history of one: a head whose own changes
/// could not be recorded lands alone, with `total` naming what it left behind.
fn lone_head<S: SqlStore>(db: &S, c: &Value) -> Result<Option<u64>> {
    let Some(total) = c["total"].as_u64() else {
        return Ok(None);
    };
    let head = db.query(
        "SELECT c.generation FROM refs r JOIN commits c ON c.id=r.commit_id \
         WHERE r.name=? AND c.origin='import'",
        &[json!(MAIN)],
    )?;
    let alone = head.first().and_then(|row| row["generation"].as_u64()) == Some(1);
    Ok((alone && stopped(db)?.is_none() && total > 1).then_some(total))
}

/// `repo_record_imported_end {reason, total?}`: ends a fill where it reached. `total` names
/// the history a head landed alone stands for. Anything else changes nothing, so a repeat,
/// or an end that lost its race with the last batch, is harmless.
pub(crate) fn end<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let reason: String = string(c, "reason")?.chars().take(REASON_CHARS).collect();
    let note = match filling(db)? {
        Some(fill) => {
            let shift = fill.oldest() as i64 - 1;
            db.query(
                "UPDATE commits SET generation=generation-? WHERE origin='import'",
                &[json!(shift)],
            )?;
            // Through negatives: a depth may not meet one still waiting to move.
            db.query(
                "UPDATE ref_chain SET depth=-depth WHERE ref=?",
                &[json!(MAIN)],
            )?;
            db.query(
                "UPDATE ref_chain SET depth=-depth-? WHERE ref=?",
                &[json!(shift), json!(MAIN)],
            )?;
            Some(HistoryStopped {
                recorded: fill.recorded,
                total: fill.total,
                reason,
            })
        }
        None => lone_head(db, c)?.map(|total| HistoryStopped {
            recorded: 1,
            total,
            reason,
        }),
    };
    let Some(note) = note else {
        return Ok(json!({ "ended": false, "history_stopped": stopped(db)? }));
    };
    let error = serde_json::to_string(&note).map_err(|e| crate::storage::bad(&e.to_string()))?;
    db.query(
        "INSERT INTO repairs(commit_id,refname,check_name,error,created_at) \
         SELECT commit_id,ref,?,?,? FROM ref_chain WHERE ref=? AND depth=1",
        &[
            json!(NOTE),
            json!(error),
            json!(number(c, "now")?),
            json!(MAIN),
        ],
    )?;
    Ok(json!({ "ended": true, "history_stopped": note }))
}
