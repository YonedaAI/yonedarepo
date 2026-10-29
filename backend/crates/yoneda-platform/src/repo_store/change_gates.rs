//! `repo_change_gates {number}`: what a change's head still needs before it can land on its
//! base, as one list. Each requirement is ready, waiting (it may still come: a check not yet
//! reported, an approval not yet given) or blocked (it will not pass as things stand: a
//! failed check, a rejection), with one line of why. `enforced` says whether landing refuses
//! while it is not ready: required checks and approvals on a protected base (the same
//! `land_gates::gates` that landing applies), a pause for anyone but the owner. Unresolved review
//! comments and a base that moved on are shown, never enforced: landing merges on the
//! server and refuses only a real conflict. Computed from existing rows; nothing is stored.
use super::auth::Actor;
use super::changes::{self, number_of, whole_repository};
use super::{break_glass, rows};
use crate::storage::SqlStore;
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::Value;
use yoneda_core::{Result, git_object::ObjectId};
mod rules;
use rules::{comments, freshness, policy};

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
            requirements.extend(policy(db, &id, settings, base_protected)?);
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
        (other, _) => requirements.push(requirement(
            GateKind::Status,
            "Status",
            GateState::Blocked,
            match other {
                "landed" => format!("Already landed on {base}"),
                _ => "Closed without landing; reopen it to land".to_owned(),
            },
            true,
        )),
    }
    let ready = requirements
        .iter()
        .all(|r| !r.enforced || r.state == GateState::Ready);
    let gates = ChangeGates {
        number: change["number"].as_i64().unwrap_or_default(),
        status,
        base,
        head,
        base_protected,
        ready,
        requirements,
    };
    serde_json::to_value(gates).map_err(|e| yoneda_core::Error::new("ENCODING", e.to_string()))
}
