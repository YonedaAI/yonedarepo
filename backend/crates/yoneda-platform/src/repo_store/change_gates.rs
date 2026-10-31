//! `repo_change_gates {number}`: what a change's head still needs before it can land on its
//! base, as one list. Each requirement is ready, waiting (it may still come: a check not yet
//! reported, an approval not yet given) or blocked (it will not pass as things stand: a
//! failed check, a rejection), with one line of why. `enforced` says whether landing refuses
//! while it is not ready: required checks and approvals on a protected base (the same
//! `land_gates::gates` that landing applies), a pause for anyone but the owner, and with that
//! switch on, unresolved agent findings. Unresolved review comments and a base that moved on
//! are shown, never enforced: landing merges on the server and refuses only a real conflict.
//! Land when cleared is stricter than a person is, so with its switch on the answer adds what
//! CTC decides (`platform_ctc`). Computed from existing rows, apart from
//! that attempt's reason.
use super::auth::Actor;
use super::changes::{self, number_of, whole_repository};
use super::{break_glass, rows};
use crate::platform_ctc::{Decision, Reason};
use crate::storage::{SqlStore, number};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;
use yoneda_core::{Result, git_object::ObjectId};
mod rules;
pub(in crate::repo_store) use rules::{comments, policy};
use rules::{findings, freshness};

/// A change's landing requirements (`GET /changes/:n/gates`).
#[derive(Debug, Serialize, JsonSchema)]
pub struct ChangeGates {
    pub number: i64,
    /// `open`, `closed` or `landed`.
    pub status: String,
    pub base: String,
    /// The change's head commit (null once its branch is gone).
    pub head: Option<String>,
    /// Landing on the base enforces checks and approvals (main, release).
    pub base_protected: bool,
    /// Every enforced requirement is ready: the head can land now.
    pub ready: bool,
    pub requirements: Vec<GateRequirement>,
    /// With the repository's switch on: what the platform waits for before it lands this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub land_when_cleared: Option<LandingClearance>,
}

/// CTC's decision on an open Landing, as the platform would land it.
#[derive(Debug, Serialize, JsonSchema)]
pub struct LandingClearance {
    pub decision: Decision,
    /// Everything in the way now; empty when it would land on the next trigger.
    pub reasons: Vec<Reason>,
    /// Why the last attempt on this head did not land, if it did not.
    pub refused: Option<ClearanceRefusal>,
}

/// An attempt that did not land.
#[derive(Debug, Serialize, JsonSchema)]
pub struct ClearanceRefusal {
    pub code: String,
    pub reason: String,
    pub at: i64,
}

/// One thing landing needs (or that is worth knowing before it).
#[derive(Debug, Serialize, JsonSchema)]
pub struct GateRequirement {
    pub kind: GateKind,
    /// What it is about: a check's name, or a short label.
    pub name: String,
    pub state: GateState,
    /// One line of why.
    pub why: String,
    /// Whether landing refuses while this is not ready.
    pub enforced: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GateKind {
    /// The change is open and has a head.
    Status,
    /// A check the policy requires.
    Check,
    Approvals,
    /// Unresolved comments anchored to lines of the diff.
    Comments,
    /// The branch against its base's latest commit.
    Freshness,
    /// Automation paused (break glass).
    Automation,
    /// Unresolved agent findings, with the repository's switch on.
    Findings,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GateState {
    Ready,
    Waiting,
    Blocked,
}

pub(super) fn requirement(
    kind: GateKind,
    name: &str,
    state: GateState,
    why: String,
    enforced: bool,
) -> GateRequirement {
    GateRequirement {
        kind,
        name: name.to_owned(),
        state,
        why,
        enforced,
    }
}

pub fn gates<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &rows::Settings,
) -> Result<Value> {
    whole_repository(actor)?;
    let change = changes::get(db, number_of(c)?)?;
    let base = change["base"].as_str().unwrap_or("main").to_owned();
    let status = change["status"].as_str().unwrap_or_default().to_owned();
    let head = change["head"].as_str().map(str::to_owned);
    let base_protected = rows::protected(&format!("refs/heads/{base}"));
    let mut requirements = Vec::new();
    match (status.as_str(), &head) {
        ("open", Some(head)) => {
            let id = ObjectId::parse(head)?;
            requirements.extend(policy(db, &id, &base, settings, base_protected)?);
            if settings.auto_landings.findings_block {
                requirements.push(findings(db, &id, &base, base_protected)?);
            }
            requirements.push(comments(db, &change["number"])?);
            requirements.push(freshness(db, &id, &base)?);
            if let Some(pause) = break_glass::paused(db)? {
                let by = pause["actor"].as_str().unwrap_or("the owner");
                requirements.push(requirement(
                    GateKind::Automation,
                    "Automation",
                    GateState::Blocked,
                    format!("Automation is paused by {by}: only the owner can land"),
                    !actor.repo_owner(),
                ));
            }
        }
        ("open", None) => requirements.push(requirement(
            GateKind::Status,
            "Branch",
            GateState::Blocked,
            format!(
                "The branch {} no longer exists",
                change["branch"].as_str().unwrap_or("")
            ),
            true,
        )),
        (other, head) => requirements.push(requirement(
            GateKind::Status,
            "Status",
            GateState::Blocked,
            match (other, head) {
                ("landed", _) => format!("Already landed on {base}"),
                (_, None) => format!(
                    "Closed: the branch {} no longer exists",
                    change["branch"].as_str().unwrap_or("")
                ),
                _ => "Closed without landing; reopen it to land".to_owned(),
            },
            true,
        )),
    }
    let ready = requirements
        .iter()
        .all(|r| !r.enforced || r.state == GateState::Ready);
    let land_when_cleared =
        super::land_when_cleared::shown(db, &change, settings, number(c, "now")?)?;
    let gates = ChangeGates {
        number: change["number"].as_i64().unwrap_or_default(),
        status,
        base,
        head,
        base_protected,
        ready,
        requirements,
        land_when_cleared,
    };
    serde_json::to_value(gates).map_err(|e| yoneda_core::Error::new("ENCODING", e.to_string()))
}
