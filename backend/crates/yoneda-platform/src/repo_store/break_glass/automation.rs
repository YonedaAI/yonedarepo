//! Automation controls: the pause that refuses automated verdicts and landings, and the
//! release of a landing lease (and queue) left behind by a merger that is down.
use super::super::rows::branch_ref;
use super::Audit;
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::{Error, Result};

/// Operations automation performs that a pause refuses for every non-owner caller.
/// Reads, commit recording and ref projection continue, so the human view stays live.
pub const PAUSED_OPS: [&str; 10] = [
    "repo_land",
    "repo_land_enqueue",
    "repo_land_claim",
    "repo_land_batch",
    "repo_check",
    "repo_check_claim",
    "repo_check_complete",
    "repo_record_repair",
    "repo_record_classes",
    "repo_bisect_step",
];

/// The pause in force, if automation is paused.
pub fn paused<S: SqlStore>(db: &S) -> Result<Option<Value>> {
    Ok(db
        .query(
            "SELECT action,actor,reason,created_at FROM break_glass WHERE action IN ('pause_automation','resume_automation') ORDER BY seq DESC LIMIT 1",
            &[],
        )?
        .into_iter()
        .next()
        .filter(|row| row["action"] == "pause_automation"))
}

pub fn refuse_if_paused<S: SqlStore>(db: &S) -> Result<()> {
    match paused(db)? {
        Some(_) => Err(Error::new(
            "AUTOMATION_PAUSED",
            "The repository owner paused automation",
        )),
        None => Ok(()),
    }
}

/// Recovery state for the human view: the pause and any landing leases.
pub fn state<S: SqlStore>(db: &S) -> Result<Value> {
    Ok(json!({
        "paused": paused(db)?,
        "land_leases": db.query("SELECT refname,epoch,expires_at FROM land_leases ORDER BY refname", &[])?,
        "pending_landings": db.query("SELECT COUNT(*) AS n FROM land_queue WHERE status='pending'", &[])?[0]["n"],
    }))
}

/// Releases a landing lease the human saw (`expected_epoch`, null: none) and optionally
/// fails the branch's pending queued landings, which otherwise block direct landings.
pub(super) fn release<S: SqlStore>(a: &Audit<S>, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let expected = match c.get("expected_epoch") {
        None => {
            return Err(bad(
                "expected_epoch is required (null when there is no lease)",
            ));
        }
        Some(Value::Null) => None,
        Some(v) => Some(
            v.as_i64()
                .ok_or_else(|| bad("expected_epoch must be a number"))?,
        ),
    };
    let epoch =
        a.db.query(
            "SELECT epoch FROM land_leases WHERE refname=?",
            &[json!(refname)],
        )?
        .first()
        .and_then(|r| r["epoch"].as_i64());
    if epoch != expected {
        return Err(Error::new(
            "STALE_EPOCH",
            "The landing lease changed since you looked; reload and decide again",
        ));
    }
    a.db.query("DELETE FROM land_leases WHERE refname=?", &[json!(refname)])?;
    let mut cancelled = 0;
    if c["cancel_pending"] == true {
        cancelled = a.db.query(
            "SELECT COUNT(*) AS n FROM land_queue WHERE refname=? AND status='pending'",
            &[json!(refname)],
        )?[0]["n"]
            .as_i64()
            .unwrap_or_default();
        let failure = json!({ "code": "BREAK_GLASS", "message": a.reason }).to_string();
        a.db.query(
            "UPDATE land_queue SET status='failed',result=?,finished_at=? WHERE refname=? AND status='pending'",
            &[json!(failure), json!(a.now), json!(refname)],
        )?;
    }
    if epoch.is_none() && cancelled == 0 {
        return Ok(json!({ "ref": refname, "released": false, "already": true }));
    }
    let detail = json!({ "epoch": epoch, "cancelled_pending": cancelled });
    let seq = a.record(
        "release_land_lease",
        BTreeMap::from([("ref", json!(refname))]),
        detail,
    )?;
    Ok(
        json!({ "ref": refname, "released": epoch.is_some(), "cancelled_pending": cancelled, "break_glass": seq }),
    )
}

pub(super) fn pause<S: SqlStore>(a: &Audit<S>, on: bool) -> Result<Value> {
    if paused(a.db)?.is_some() == on {
        return Ok(json!({ "paused": on, "already": true }));
    }
    let action = if on {
        "pause_automation"
    } else {
        "resume_automation"
    };
    let seq = a.record(action, BTreeMap::new(), json!({}))?;
    Ok(json!({ "paused": on, "break_glass": seq }))
}
