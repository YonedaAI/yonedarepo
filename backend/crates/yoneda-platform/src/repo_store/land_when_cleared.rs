//! Land when cleared: what replaces clicking merge. With the repository's switch on, whatever
//! can clear a Landing asks for a queue job (`triggers`). The job asks here whether the
//! Landing's exact head may land (`clearance`), then lands that head with `repo_land`, naming
//! the Landing and the head it evaluated. That call runs the same rules again in its own
//! transaction (`guard`), so nothing that arrived between the two calls slips through: not a
//! newer push, not a rejection. A landing that has to wait for a merge joins the queue, whose
//! claim and batch run them a third time (`still_cleared`), so a ticket answers for its Landing
//! as of the moment it lands.
//!
//! The platform evaluates rules and moves a ref; it starts no agent. Explicit landings never
//! pass through here. The job's identity is `ACTOR`, a platform role that lands nothing but a
//! Landing it names, and the Landing keeps the record of why (`changes.clearance`). A refused
//! attempt leaves the Landing open with its reason and is tried again only on the next trigger.
use super::auth::Actor;
use super::change_gates::{Clearance, ClearanceHold, ClearanceRefusal};
use super::changes::{self, number_of};
use super::rows::{self, CommitRow, Settings};
use super::{capacity, legal_hold};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};
mod holds;
mod triggers;
pub(super) use triggers::{ask_for_jobs, watching};

/// Who the log says landed a cleared Landing.
pub(super) const ACTOR: &str = "platform:land-when-cleared";
const HEAD_MOVED: &str = "HEAD_MOVED";
/// Longest reason kept on a Landing.
const MAX_REASON: usize = 500;
/// Approvers named in a Landing's record.
const MAX_APPROVERS: u64 = 16;

/// A Landing that may land now, with what decided it.
pub(super) struct Cleared {
    number: i64,
    commit: ObjectId,
    refname: String,
    gates: Value,
    approved_by: Vec<Value>,
}

enum Verdict {
    /// Nothing the platform lands: closed, landed, or its branch is gone.
    Done,
    Waiting(Vec<ClearanceHold>),
    Cleared(Cleared),
}

fn moved() -> Error {
    Error::new(
        HEAD_MOVED,
        "The Landing's head moved; its new head has its own turn",
    )
}

fn off() -> Error {
    Error::new("NOT_READY", "Land when cleared is off")
}

fn hold_error(hold: &ClearanceHold) -> Error {
    Error::new(&hold.code, hold.reason.clone())
}

/// What the rules say of `change` as it stands, from what this database holds.
fn assess<S: SqlStore>(db: &S, change: &Value, settings: &Settings) -> Result<Verdict> {
    let Some(head) = change["head"]
        .as_str()
        .filter(|_| change["status"] == "open")
    else {
        return Ok(Verdict::Done);
    };
    let id = ObjectId::parse(head)?;
    let refname = format!("refs/heads/{}", change["base"].as_str().unwrap_or_default());
    let Some(commit) = rows::commit_row(db, &id)? else {
        return Ok(Verdict::Waiting(vec![holds::hold(
            "NOT_RECORDED",
            "Its head is not recorded here yet".to_owned(),
        )]));
    };
    let holds = holds::holds(db, change, &commit, &refname, settings)?;
    if !holds.is_empty() {
        return Ok(Verdict::Waiting(holds));
    }
    let gates = holds::deciding_gates(db, &commit, &refname, settings)?;
    let approved_by = db
        .query(
            "SELECT principal FROM reviews WHERE commit_id=? AND decision='approve' \
             ORDER BY recorded_at LIMIT ?",
            &[json!(id.hex()), json!(MAX_APPROVERS)],
        )?
        .iter()
        .map(|row| row["principal"].clone())
        .collect();
    Ok(Verdict::Cleared(Cleared {
        number: change["number"].as_i64().unwrap_or_default(),
        commit: id,
        refname,
        gates,
        approved_by,
    }))
}

/// What only the adapter can answer: the legal hold, which lives in the owner's authority, and
/// the storage limit it passes. A command without a hold's answer is sent back for one.
fn platform_hold<S: SqlStore>(
    db: &S,
    c: &Value,
    settings: &Settings,
    cleared: &Cleared,
) -> Result<Option<ClearanceHold>> {
    match legal_hold::require_free(c, &settings.workspace) {
        Err(e) if e.code == "LEGAL_HOLD" => return Ok(Some(holds::hold("LEGAL_HOLD", e.message))),
        other => other?,
    }
    if capacity::landing_refused(db, c, &cleared.refname, &cleared.commit)? {
        let refusal = capacity::refusal();
        return Ok(Some(holds::hold("REPO_FULL", refusal.message)));
    }
    Ok(None)
}

fn record<S: SqlStore>(db: &S, number: i64, record: &Value) -> Result<()> {
    db.query(
        "UPDATE changes SET clearance=? WHERE number=?",
        &[json!(record.to_string()), json!(number)],
    )?;
    Ok(())
}

fn refused<S: SqlStore>(
    db: &S,
    number: i64,
    head: &Value,
    hold: &ClearanceHold,
    now: i64,
) -> Result<()> {
    let reason: String = hold.reason.chars().take(MAX_REASON).collect();
    let refusal = json!({ "outcome": "refused", "head": head, "code": hold.code,
                          "reason": reason, "at": now });
    record(db, number, &refusal)
}

/// `repo_land_clearance {number, failed?: {head, code, message}}`, the job's own op: whether the
/// Landing's head may land, or with `failed`, why an attempt on `head` did not.
pub fn clearance<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let landing = number_of(c)?;
    let now = number(c, "now")?;
    let change = changes::get(db, landing)?;
    if let Some(failed) = c.get("failed").filter(|f| f.is_object()) {
        let hold = holds::hold(
            failed["code"].as_str().unwrap_or("REFUSED"),
            failed["message"].as_str().unwrap_or_default().to_owned(),
        );
        if change["status"] == "open" {
            refused(db, landing, &failed["head"], &hold, now)?;
        }
        return Ok(json!({ "recorded": true }));
    }
    if !settings.auto_landings.land_when_cleared {
        return Ok(json!({ "state": "off" }));
    }
    Ok(match assess(db, &change, settings)? {
        Verdict::Done => json!({ "state": "done" }),
        Verdict::Waiting(holds) => json!({ "state": "waiting", "waiting": holds }),
        Verdict::Cleared(cleared) => match platform_hold(db, c, settings, &cleared)? {
            Some(hold) => {
                refused(db, landing, &json!(cleared.commit), &hold, now)?;
                json!({ "state": "waiting", "waiting": [hold] })
            }
            None => json!({
                "state": "cleared", "ref": cleared.refname, "commit": cleared.commit,
                "source_repo": change["source_repo"], "source_branch": change["source_branch"],
            }),
        },
    })
}

/// The job's `repo_land {clearance, expected_head}`: the rules again, in the landing's own
/// transaction. `None` for anyone else, whose rights decide as ever, and for a duplicate
/// delivery of a landing that already happened, which `land` answers as `already`.
pub(super) fn guard<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &Settings,
) -> Result<Option<Cleared>> {
    if actor.principal != ACTOR {
        return Ok(None);
    }
    let number = c["clearance"].as_i64().ok_or_else(bare)?;
    let expected = rows::object_id(c, "expected_head")?;
    if rows::object_id(c, "commit")? != expected {
        return Err(moved());
    }
    let change = changes::get(db, number)?;
    if change["status"] == "landed" && change["landed_commit"] == json!(expected) {
        return Ok(None);
    }
    if change["status"] != "open" || change["head"] != json!(expected) {
        return Err(moved());
    }
    if !settings.auto_landings.land_when_cleared {
        return Err(off());
    }
    let cleared = cleared(assess(db, &change, settings)?)?;
    match platform_hold(db, c, settings, &cleared)? {
        Some(hold) => Err(hold_error(&hold)),
        None => Ok(Some(cleared)),
    }
}

fn cleared(verdict: Verdict) -> Result<Cleared> {
    match verdict {
        Verdict::Cleared(cleared) => Ok(cleared),
        Verdict::Waiting(holds) => Err(holds.first().map_or_else(off, hold_error)),
        Verdict::Done => Err(moved()),
    }
}

fn bare() -> Error {
    Error::new("FORBIDDEN", "This role lands only a Landing it names")
}

/// The job's role never queues a landing but through `guard`.
pub(super) fn refuse_bare_land(actor: &Actor) -> Result<()> {
    if actor.principal == ACTOR {
        return Err(bare());
    }
    Ok(())
}

/// After `repo_land`: the record, if it landed now. A queued ticket records when it lands.
pub(super) fn after_land<S: SqlStore>(
    db: &S,
    c: &Value,
    cleared: Option<&Cleared>,
    landed: &Value,
) -> Result<()> {
    match cleared {
        Some(cleared) if landed["landed"] == true && landed["already"] != true => {
            self::landed(db, cleared, landed["version"].as_u64(), number(c, "now")?)
        }
        _ => Ok(()),
    }
}

/// The Landing's record: the platform landed it, who approved, and what decided it.
pub(super) fn landed<S: SqlStore>(
    db: &S,
    cleared: &Cleared,
    version: Option<u64>,
    now: i64,
) -> Result<()> {
    let landed = json!({
        "outcome": "landed", "head": cleared.commit, "by": ACTOR, "at": now, "version": version,
        "approved_by": cleared.approved_by, "gates": cleared.gates,
    });
    record(db, cleared.number, &landed)
}

/// Whether a `land_queue` row is the job's.
pub(super) fn by_job(row: &Value) -> bool {
    row["principal"] == ACTOR
}

/// A queued ticket's Landing, as of now: `commit` still heads an open Landing on `refname`, and
/// that Landing still clears.
pub(super) fn still_cleared<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<Cleared> {
    if !settings.auto_landings.land_when_cleared {
        return Err(off());
    }
    let rows = db.query(
        "SELECT c.number FROM changes c JOIN refs r ON r.name='refs/heads/'||c.branch \
         WHERE c.status='open' AND 'refs/heads/'||c.base=? AND r.commit_id=? LIMIT 1",
        &[json!(refname), json!(commit.id.hex())],
    )?;
    let number = rows.first().and_then(|r| r["number"].as_i64());
    let change = changes::get(db, number.ok_or_else(moved)?)?;
    cleared(assess(db, &change, settings)?)
}

/// What the page shows of an open Landing with the switch on (`GET /changes/:n/gates`): what it
/// waits for, and why the last attempt on this head did not land.
pub(super) fn shown<S: SqlStore>(
    db: &S,
    change: &Value,
    settings: &Settings,
) -> Result<Option<Clearance>> {
    if !settings.auto_landings.land_when_cleared {
        return Ok(None);
    }
    let waiting = match assess(db, change, settings)? {
        Verdict::Done => return Ok(None),
        Verdict::Waiting(holds) => holds,
        Verdict::Cleared(_) => Vec::new(),
    };
    let last = &change["clearance"];
    let refused = (last["outcome"] == "refused" && last["head"] == change["head"]).then(|| {
        ClearanceRefusal {
            code: last["code"].as_str().unwrap_or_default().to_owned(),
            reason: last["reason"].as_str().unwrap_or_default().to_owned(),
            at: last["at"].as_i64().unwrap_or_default(),
        }
    });
    Ok(Some(Clearance { waiting, refused }))
}
