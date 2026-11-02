//! What asks for the clearance job: anything that can clear a Landing, in the transaction that
//! did it. A passed check, an approval, a resolved comment, a new head, a review class, a
//! Landing opened or reopened. Their answer carries `land_checks`, the Landings to look at; the
//! adapter takes that field off and sends one queue job each, so nothing polls. Only with the
//! switch on: off, an op reads nothing more and its answer is what it was. Failing checks,
//! rejections and refused attempts can't clear anything, so a job never asks for a job.
//!
//! Some things clear a Landing from outside it, and each has to ask for those it held (`held_for`):
//! - the way ahead clearing: whatever takes a Landing out of the queue. Only a separation hold is
//!   asked for, and a separation refusal asks nothing, so that can't go round;
//! - the owner's resume, for what the pause held;
//! - a legal hold lifting, which the repository hears from the adapter's job (`hold_lifted`);
//! - room coming back: compaction moving the log out, or a read of the size finding it under the
//!   limit. The derive job reads it at most every 10 minutes, so an idle repository waits for its
//!   next event.
//!
//! The switch going on asks for every open Landing, since one may have cleared while it was off.
use crate::platform_ctc::{AUTOMATION_PAUSED, LEGAL_HOLD, REPO_FULL, SEPARATION};
use crate::repo_store::capacity;
use crate::repo_store::op::{ForkOp, MaintenanceOp as M, RepoOp as R, StoreOp};
use crate::repo_store::rows::{self, Settings};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::Result;

/// Jobs one op asks for: a queue batch's limit. A branch batch past it waits for its next event.
const MOST: u64 = 100;
/// Open Landings, newest first, looked at for a separation hold.
const HELD: u64 = 200;

/// Where the log stood before the op, when the repository's switch is on or this op turns it on.
pub(in crate::repo_store) fn watching<S: SqlStore>(
    db: &S,
    op: StoreOp,
    c: &Value,
    settings: &Settings,
) -> Option<u64> {
    let on = settings.auto_landings.land_when_cleared;
    if matches!(op, StoreOp::Repo(R::AutoLandings)) && c["land_when_cleared"] == true {
        return (!on).then_some(0);
    }
    let moves = matches!(
        op,
        StoreOp::Repo(R::BranchSet | R::BranchBatch | R::RecordPushed | R::Land | R::LandBatch)
            | StoreOp::Fork(ForkOp::Mirror)
    );
    match (on, moves) {
        (false, _) => None,
        (true, true) => rows::current_version(db).ok(),
        (true, false) => Some(0),
    }
}

/// Open Landings whose head is `commit`.
fn headed_by<S: SqlStore>(db: &S, commit: &Value) -> Result<Vec<Value>> {
    db.query(
        "SELECT c.number FROM changes c JOIN refs r ON r.name='refs/heads/'||c.branch \
         WHERE c.status='open' AND r.commit_id=? LIMIT ?",
        &[commit.clone(), json!(MOST)],
    )
}

/// Open Landings whose branch moved after version `since`.
fn moved_since<S: SqlStore>(db: &S, since: u64) -> Result<Vec<Value>> {
    db.query(
        "SELECT number FROM changes WHERE status='open' AND 'refs/heads/'||branch IN \
         (SELECT refname FROM txlog WHERE version>?) LIMIT ?",
        &[json!(since), json!(MOST)],
    )
}

/// Open Landings the newest decision on which names `code`.
fn held_for<S: SqlStore>(db: &S, code: &str) -> Result<Vec<Value>> {
    db.query(
        "SELECT number FROM (SELECT number,clearance FROM changes WHERE status='open' \
         ORDER BY number DESC LIMIT ?) \
         WHERE instr(json_extract(clearance,'$[0].reasons'),?)>0 LIMIT ?",
        &[json!(HELD), json!(code), json!(MOST)],
    )
}

/// Every open Landing, oldest first.
fn open<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    db.query(
        "SELECT number FROM changes WHERE status='open' ORDER BY number LIMIT ?",
        &[json!(MOST)],
    )
}

/// What the storage limit held, once there is room.
fn room_again<S: SqlStore>(db: &S, c: &Value) -> Result<Vec<Value>> {
    if capacity::full(db, c)? {
        return Ok(Vec::new());
    }
    held_for(db, REPO_FULL)
}

fn separated<S: SqlStore>(db: &S) -> Result<Vec<Value>> {
    held_for(db, SEPARATION)
}

/// What moved, with whoever was held behind it.
fn with_separated<S: SqlStore>(db: &S, mut rows: Vec<Value>) -> Result<Vec<Value>> {
    for row in separated(db)? {
        if !rows.contains(&row) {
            rows.push(row);
        }
    }
    rows.truncate(MOST as usize);
    Ok(rows)
}

fn affected<S: SqlStore>(
    db: &S,
    op: StoreOp,
    c: &Value,
    since: u64,
    result: &Value,
) -> Result<Vec<Value>> {
    let one = |number: &Value| Ok(vec![json!({ "number": number })]);
    let op = match op {
        StoreOp::Fork(ForkOp::Mirror) => return with_separated(db, moved_since(db, since)?),
        StoreOp::Maintenance(M::CompactDone) => return room_again(db, c),
        StoreOp::Repo(op) => op,
        _ => return Ok(Vec::new()),
    };
    match op {
        R::Review if c["decision"] == "approve" => headed_by(db, &c["commit"]),
        R::Check if c["status"] == "pass" => headed_by(db, &c["commit"]),
        R::RecordClasses => headed_by(db, &c["commit"]),
        R::CheckComplete if c["outcome"] == "pass" && result["already"] != true => {
            let run = db.query(
                "SELECT commit_id FROM check_runs WHERE id=?",
                std::slice::from_ref(&c["run_id"]),
            )?;
            match run.first() {
                Some(row) => headed_by(db, &row["commit_id"]),
                None => Ok(Vec::new()),
            }
        }
        R::ChangeComment if result["resolved"].as_i64().unwrap_or(0) > 0 => one(&c["number"]),
        R::ChangeReopen => one(&c["number"]),
        R::ChangeCreate => one(&result["number"]),
        R::BranchSet | R::BranchBatch | R::RecordPushed | R::Land | R::LandBatch => {
            with_separated(db, moved_since(db, since)?)
        }
        R::ChangeClose | R::LandChangesets | R::LandSubmitted => separated(db),
        R::BreakGlass if c["action"] == "resume_automation" => held_for(db, AUTOMATION_PAUSED),
        R::AutoLandings if c["land_when_cleared"] == true => open(db),
        R::LandClearance if c["hold_lifted"] == true => held_for(db, LEGAL_HOLD),
        R::Storage => room_again(db, c),
        R::LandClaim if result["failed"].as_array().is_some_and(|f| !f.is_empty()) => separated(db),
        R::LandClearance if c["failed"].is_object() && c["failed"]["code"] != SEPARATION => {
            separated(db)
        }
        _ => Ok(Vec::new()),
    }
}

/// Adds `land_checks` to an op's answer when it may have cleared a Landing. Never fails the op,
/// whose work is done: a read that fails here costs the Landing this trigger, not the next.
pub(in crate::repo_store) fn ask_for_jobs<S: SqlStore>(
    db: &S,
    op: StoreOp,
    c: &Value,
    since: Option<u64>,
    result: &mut Value,
) {
    let Some(since) = since else { return };
    let Ok(rows) = affected(db, op, c, since, result) else {
        return;
    };
    let numbers: Vec<i64> = rows.iter().filter_map(|r| r["number"].as_i64()).collect();
    if let (false, Some(fields)) = (numbers.is_empty(), result.as_object_mut()) {
        fields.insert("land_checks".into(), json!(numbers));
    }
}
