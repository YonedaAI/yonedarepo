//! Land when cleared, CTC's first job: what replaces clicking merge. With the repository's
//! switch on, whatever can clear a Landing asks for a queue job (`triggers`). This gathers the
//! Landing's state (`state`) and `platform_ctc::clearance`, a pure function of that state,
//! decides. The page asks the same function what a Landing is waiting for (`shown`).
//!
//! The job asks here (`ask`), again with the head's Risk once nothing else stands in the way,
//! then lands that head with `repo_land`, naming the Landing and the head it evaluated. That
//! call decides again in its own transaction (`guard`), so nothing that arrived between the
//! calls slips through: not a newer push, not a rejection. A landing that has to wait for a
//! merge joins the queue, whose claim and batch decide a third time (`still_cleared`), so a
//! ticket answers for its Landing as of the moment it lands.
//!
//! Every decision the job makes is recorded on the Landing (`record`), so "why did this land?"
//! always has an answer. Every decision also looks at who is ahead in the queue (`separation`).
//!
//! The platform evaluates rules and moves a ref; it starts no agent. Explicit landings never
//! pass through here. The job's identity is `ACTOR`, a platform role that lands nothing but a
//! Landing it names. A refused attempt leaves the Landing open with its reason and is tried
//! again only on the next trigger.
use super::auth::Actor;
use super::change_gates::LandingClearance;
use super::changes::{self, number_of};
use super::rows::{self, CommitRow, Settings};
use super::traffic::Queue;
use crate::platform_ctc::{Clearance, Decision, LandingState, Reason, RiskScore, clearance};
use crate::storage::{SqlStore, bad, number};
use record::{decision_row, failed_attempt, last_refusal, record, scored_risk};
use serde_json::{Value, json};
use state::{Answers, landing_state};
use yoneda_core::{Error, Result, git_object::ObjectId};
mod record;
mod separation;
mod state;
mod triggers;
pub(super) use record::landed;
pub(super) use triggers::{ask_for_jobs, watching};

/// Who the log says landed a cleared Landing.
pub(super) const ACTOR: &str = "platform:land-when-cleared";
const HEAD_MOVED: &str = "HEAD_MOVED";

/// A Landing that may land now, with what decided it.
pub(super) struct Cleared {
    number: i64,
    commit: ObjectId,
    state: LandingState,
}

/// What CTC says of an open Landing.
struct Judged {
    commit: ObjectId,
    refname: String,
    state: LandingState,
    decided: Clearance,
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

fn reason_error(reason: &Reason) -> Error {
    Error::new(&reason.code, reason.reason.clone())
}

/// CTC's decision on `change` as it stands. `None`: nothing the platform lands, being closed,
/// landed, or its branch gone.
fn judge<S: SqlStore>(
    db: &S,
    change: &Value,
    settings: &Settings,
    queue: &Queue,
    answers: Answers,
    risk: Option<RiskScore>,
) -> Result<Option<Judged>> {
    let Some(head) = change["head"]
        .as_str()
        .filter(|_| change["status"] == "open")
    else {
        return Ok(None);
    };
    let id = ObjectId::parse(head)?;
    let refname = format!("refs/heads/{}", change["base"].as_str().unwrap_or_default());
    let commit = rows::recorded(db, &id)?;
    let mut state = landing_state(db, change, &commit, &refname, settings, answers, risk)?;
    state.ahead = separation::ahead(db, queue, change, &id, &refname)?;
    let decided = clearance(&state);
    Ok(Some(Judged {
        commit: id,
        refname,
        state,
        decided,
    }))
}

/// `repo_land_clearance {number, risk?, failed?: {head, code, message}}`, the job's own op: CTC's
/// decision on the Landing's head, recorded; or with `failed`, why an attempt did not land. With
/// only Risk missing it answers `needs_risk` and records nothing: the job hasn't decided yet.
pub fn ask<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let landing = number_of(c)?;
    if let Some(failed) = c.get("failed").filter(|f| f.is_object()) {
        return failed_attempt(db, c, landing, failed);
    }
    if !settings.auto_landings.land_when_cleared {
        return Ok(json!({ "state": "off" }));
    }
    let change = changes::get(db, landing)?;
    let risk: Option<RiskScore> = c
        .get("risk")
        .filter(|r| r.is_object())
        .map(|risk| serde_json::from_value(risk.clone()).map_err(|_| bad("risk is malformed")))
        .transpose()?;
    // A score means nothing else stood in the way, so the adapter's answers are worth having.
    let answers = risk.is_some().then_some(c);
    let now = number(c, "now")?;
    let queue = Queue::read(db, settings, now)?;
    let Some(Judged {
        commit,
        refname,
        state,
        decided,
    }) = judge(db, &change, settings, &queue, answers, risk)?
    else {
        return Ok(json!({ "state": "done" }));
    };
    let mut answer = json!({
        "state": decided.decision(), "reasons": decided.reasons(), "ref": refname, "commit": commit,
        "source_repo": change["source_repo"], "source_branch": change["source_branch"],
    });
    if decided.needs_risk() {
        answer["needs_risk"] = json!(true);
        return Ok(answer);
    }
    let row = decision_row(&json!(commit), &decided, Some(&state), None, now);
    record(db, landing, row)?;
    Ok(answer)
}

/// The job's `repo_land {clearance, expected_head}`: the decision again, in the landing's own
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
    let risk = scored_risk(&change, &expected);
    let queue = Queue::read(db, settings, crate::storage::number(c, "now")?)?;
    cleared(number, judge(db, &change, settings, &queue, Some(c), risk)?).map(Some)
}

fn cleared(number: i64, judged: Option<Judged>) -> Result<Cleared> {
    let judged = judged.ok_or_else(moved)?;
    match judged.decided {
        Clearance::Cleared => Ok(Cleared {
            number,
            commit: judged.commit,
            state: judged.state,
        }),
        refused => Err(refused.reasons().first().map_or_else(off, reason_error)),
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
            record::landed(db, cleared, landed["version"].as_u64(), number(c, "now")?)
        }
        _ => Ok(()),
    }
}

/// Whether a `land_queue` row is the job's.
pub(super) fn by_job(row: &Value) -> bool {
    row["principal"] == ACTOR
}

/// A queued ticket's Landing, as of now: `commit` still heads an open Landing on `refname`, and
/// CTC still clears it.
pub(super) fn still_cleared<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
    now: i64,
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
    let number = number.ok_or_else(moved)?;
    let change = changes::get(db, number)?;
    let risk = scored_risk(&change, &commit.id);
    let queue = Queue::read(db, settings, now)?;
    cleared(number, judge(db, &change, settings, &queue, None, risk)?)
}

/// What the page shows of an open Landing with the switch on (`GET /changes/:n/gates`): the same
/// decision, on the Risk the job last scored, and why the last attempt on this head failed.
pub(super) fn shown<S: SqlStore>(
    db: &S,
    change: &Value,
    settings: &Settings,
    now: i64,
) -> Result<Option<LandingClearance>> {
    if !settings.auto_landings.land_when_cleared {
        return Ok(None);
    }
    let queue = Queue::read(db, settings, now)?;
    Ok(decided_on(db, change, settings, &queue)?.map(|(decision, reasons)| LandingClearance {
        decision,
        reasons,
        refused: last_refusal(change),
    }))
}

/// What CTC says of an open Landing as it stands, on the Risk the job last scored, whether or
/// not the repository's switch is on. Reads what `judge` reads, and records nothing.
pub(super) fn decided_on<S: SqlStore>(
    db: &S,
    change: &Value,
    settings: &Settings,
    queue: &Queue,
) -> Result<Option<(Decision, Vec<Reason>)>> {
    let risk = change["head"]
        .as_str()
        .and_then(|head| ObjectId::parse(head).ok())
        .and_then(|head| scored_risk(change, &head));
    let judged = judge(db, change, settings, queue, None, risk)?;
    Ok(judged.map(|Judged { decided, .. }| (decided.decision(), decided.reasons().to_vec())))
}
