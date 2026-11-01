//! What a check run shows: its row, with the verdict's evidence from wherever it is stored.
use crate::storage::{SqlStore, string};
use serde_json::{Value, json};
use yoneda_core::{Result, git_object::ObjectId};

/// A run's result: its own copy, else (a verdict stored under `_check_evidence`) the row it
/// wrote in `checks`. A policy digest fixes its runners and a runner's name refuses posted
/// checks, so nothing else writes that row.
const RESULT: &str = "COALESCE(r.result,(SELECT e.evidence FROM checks e WHERE e.commit_id=r.commit_id \
     AND e.name=r.name AND e.policy_digest=r.policy_digest AND r.status IN ('passed','failed')))";

pub fn run_op<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = string(c, "run_id")?;
    let mut row = super::checks::run_row(db, &id)?;
    row["result"] = db.query(
        &format!("SELECT {RESULT} AS result FROM check_runs r WHERE r.id=?"),
        &[json!(id)],
    )?[0]["result"]
        .clone();
    row["runner"] =
        serde_json::from_str(row["runner"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    row["result"] =
        serde_json::from_str(row["result"].as_str().unwrap_or("null")).unwrap_or(Value::Null);
    Ok(row)
}

pub fn runs_for<S: SqlStore>(db: &S, commit: &ObjectId) -> Result<Vec<Value>> {
    db.query(
        &format!(
            "SELECT r.id,r.name,r.status,r.epoch,r.requested_by,r.created_at,r.finished_at,{RESULT} AS result \
             FROM check_runs r WHERE r.commit_id=? ORDER BY r.created_at,r.name"
        ),
        &[json!(commit.hex())],
    )
}
