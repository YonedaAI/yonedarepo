//! CTC's record: every decision the job makes, on the Landing, in `changes.clearance`. Newest
//! first, with its reasons, the head it judged and the state it judged, so "why did this land?"
//! has an answer that replays. It is bounded (`MAX_DECISIONS`), and landing is the last thing a
//! Landing records. A decision that says what the newest says isn't added, so duplicate
//! deliveries add nothing. A row with no state is an attempt the rules cleared that still failed.
use super::{ACTOR, Cleared};
use crate::platform_ctc::{Clearance, LandingState, RiskScore, attempt_failed};
use crate::repo_store::change_gates::ClearanceRefusal;
use crate::repo_store::changes;
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{Result, git_object::ObjectId};

/// Decisions kept on a Landing, newest first.
const MAX_DECISIONS: usize = 32;
/// Longest reason kept from a failed attempt.
const MAX_REASON: usize = 500;

/// The Landing's recorded decisions, newest first.
pub(super) fn decisions(change: &Value) -> Vec<Value> {
    change["clearances"].as_array().cloned().unwrap_or_default()
}

/// The Risk the job last scored for this head, which is how the page and a landing know it.
pub(super) fn scored_risk(change: &Value, head: &ObjectId) -> Option<RiskScore> {
    decisions(change)
        .iter()
        .filter(|row| row["head"] == json!(head))
        .find_map(|row| serde_json::from_value(row["state"]["risk"].clone()).ok())
}

/// Adds a decision to the Landing's record, unless it says what the newest one says.
pub(super) fn record<S: SqlStore>(db: &S, number: i64, row: Value) -> Result<()> {
    let mut log = decisions(&changes::get(db, number)?);
    let same = |newest: &Value| {
        ["head", "decision", "reasons", "landed_version"]
            .iter()
            .all(|key| newest[*key] == row[*key])
    };
    if log.first().is_some_and(same) {
        return Ok(());
    }
    log.insert(0, row);
    log.truncate(MAX_DECISIONS);
    db.query(
        "UPDATE changes SET clearance=? WHERE number=?",
        &[json!(json!(log).to_string()), json!(number)],
    )?;
    Ok(())
}

pub(super) fn decision_row(
    head: &Value,
    decided: &Clearance,
    state: Option<&LandingState>,
    landed_version: Option<u64>,
    now: i64,
) -> Value {
    json!({
        "head": head, "decision": decided.decision(), "reasons": decided.reasons(),
        "state": state, "landed_version": landed_version, "actor": ACTOR, "at": now,
    })
}

/// An attempt that did not land: why, on the head it was for.
pub(super) fn failed_attempt<S: SqlStore>(
    db: &S,
    c: &Value,
    landing: i64,
    failed: &Value,
) -> Result<Value> {
    let code = failed["code"].as_str().unwrap_or("REFUSED");
    let message = failed["message"].as_str().unwrap_or_default();
    let why: String = message.chars().take(MAX_REASON).collect();
    if changes::get(db, landing)?["status"] == "open" {
        let decided = attempt_failed(code, &why);
        let row = decision_row(&failed["head"], &decided, None, None, number(c, "now")?);
        record(db, landing, row)?;
    }
    Ok(json!({ "recorded": true }))
}

/// The decision that landed it: this one answers "why did this land?".
pub(in crate::repo_store) fn landed<S: SqlStore>(
    db: &S,
    cleared: &Cleared,
    version: Option<u64>,
    now: i64,
) -> Result<()> {
    let head = json!(cleared.commit);
    let row = decision_row(
        &head,
        &Clearance::Cleared,
        Some(&cleared.state),
        version,
        now,
    );
    record(db, cleared.number, row)
}

/// The attempt that failed on this head, if that is the newest word on it.
pub(super) fn last_refusal(change: &Value) -> Option<ClearanceRefusal> {
    let log = decisions(change);
    let newest = log.iter().find(|row| row["head"] == change["head"])?;
    let first = &newest["reasons"][0];
    newest["state"].is_null().then(|| ClearanceRefusal {
        code: first["code"].as_str().unwrap_or_default().to_owned(),
        reason: first["reason"].as_str().unwrap_or_default().to_owned(),
        at: newest["at"].as_i64().unwrap_or_default(),
    })
}
