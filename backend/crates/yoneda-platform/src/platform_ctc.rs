//! CTC, Code Traffic Control: the one decision about a Landing. `clearance` takes what is true
//! of a Landing's head and says Cleared, Hold or GoAround, with its reasons. It reads nothing
//! and calls nothing, so the page's "what is this waiting for", the job's decision and the
//! landing's own last check are one answer, and a recorded state replays to the same decision.
//! Rules only: no model is asked anything. An agent's verdict reaches it only as what the
//! repository already holds, a check result or a comment on a line. Risk has no say: it is an
//! uncalibrated beta reading on the Landing's page (`platform_risk`).
//!
//! Hold: it waits, and what it waits for can come without new work. GoAround: the work has to
//! answer, so the Landing goes back. A go-around outranks a hold and keeps every reason.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[cfg(test)]
mod tests;

/// What is true of a Landing's head right now.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LandingState {
    /// Marked as a draft in its title.
    pub draft: bool,
    /// `land_gates::gates` is ready for this head on its base.
    pub gates_ready: bool,
    /// Each required check and the approvals, as landing decides them.
    pub requirements: Vec<Requirement>,
    /// Unresolved agent findings that block, with the repository's switch on.
    pub open_findings: u64,
    /// Approvals of this head by accounts other than its author's.
    pub approvals: u64,
    pub approved_by: Vec<String>,
    /// A review class the policy auto-approves covers all it would land.
    pub auto_approved: bool,
    /// The policy requires a check or an approval.
    pub rules_ask: bool,
    /// Proposed from a fork.
    pub from_fork: bool,
    /// Failed on this head and not required: how an agent's `block_at` reads.
    pub failed_checks: Vec<String>,
    /// A person's comment on a line waits for an answer.
    pub unresolved_comments: bool,
    pub base_exists: bool,
    /// The base changed what this head read.
    pub conflict: Option<String>,
    /// Who paused automation.
    pub paused_by: Option<String>,
    /// A path-limited token that worked on it doesn't cover all it would land.
    pub outside_grant: bool,
    pub legal_hold: Option<String>,
    pub repo_full: Option<String>,
    /// Landings ahead in the queue this one has a read conflict with. Absent from a state
    /// recorded before separation, which replays as nothing ahead.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ahead: Vec<Ahead>,
}

/// A Landing ahead in the queue, and the paths where one wrote what the other read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ahead {
    pub landing: i64,
    pub paths: Vec<String>,
}

/// One requirement of the policy, as the page words it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    pub name: String,
    pub state: RequirementState,
    pub why: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequirementState {
    Ready,
    Waiting,
    Blocked,
}

/// One thing in the way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Reason {
    pub code: String,
    /// One line of why.
    pub reason: String,
}

fn reason(code: &str, why: impl Into<String>) -> Reason {
    Reason {
        code: code.to_owned(),
        reason: why.into(),
    }
}

/// `Clearance` by name, for answers and records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Cleared,
    Hold,
    GoAround,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Clearance {
    Cleared,
    Hold { reasons: Vec<Reason> },
    GoAround { reasons: Vec<Reason> },
}

impl Clearance {
    pub fn decision(&self) -> Decision {
        match self {
            Self::Cleared => Decision::Cleared,
            Self::Hold { .. } => Decision::Hold,
            Self::GoAround { .. } => Decision::GoAround,
        }
    }

    pub fn reasons(&self) -> &[Reason] {
        match self {
            Self::Cleared => &[],
            Self::Hold { reasons } | Self::GoAround { reasons } => reasons,
        }
    }
}

/// Held while the owner has automation paused; their resume asks again.
pub(crate) const AUTOMATION_PAUSED: &str = "AUTOMATION_PAUSED";
/// Held behind a Landing ahead in the queue (`repo_store::land_when_cleared::separation`).
pub(crate) const SEPARATION: &str = "SEPARATION";
/// A refused attempt the work has to answer; any other is a hold.
const GOES_AROUND: [&str; 5] = [
    "CONFLICT",
    "STALE_PARENT",
    "GATES",
    "CHECK_FAILED",
    "FINDINGS",
];

/// What the work has to answer: the Landing goes back.
fn go_arounds(state: &LandingState) -> Vec<Reason> {
    let mut back: Vec<Reason> = state
        .requirements
        .iter()
        .filter(|r| r.state == RequirementState::Blocked)
        .map(|r| reason("GATES", format!("{}: {}", r.name, r.why)))
        .collect();
    if state.open_findings > 0 {
        let why = format!("{} unresolved agent findings", state.open_findings);
        back.push(reason("FINDINGS", why));
    }
    back.extend(
        (state.failed_checks.iter())
            .map(|c| reason("CHECK_FAILED", format!("{c} failed on this head"))),
    );
    back.extend(state.conflict.iter().map(|c| reason("CONFLICT", c.clone())));
    back
}

/// Something has to have cleared it. Rules that ask for nothing would make every push land, and
/// `write` alone would be `land`. A fork's work is anyone's, so it needs an approval of its head
/// whatever else the rules accept.
fn evidence(state: &LandingState) -> Option<Reason> {
    if state.from_fork {
        return (state.approvals == 0).then(|| {
            reason(
                "FORK_NEEDS_APPROVAL",
                "A Landing from a fork lands only with an approval of its head",
            )
        });
    }
    (state.approvals == 0 && !state.rules_ask && !state.auto_approved).then(|| {
        reason(
            "NOTHING_REQUIRED",
            "The landing rules ask for no approval or check, so nothing clears it",
        )
    })
}

/// What it can wait for. `back`: the go-arounds, which already say why the gates aren't ready.
fn holds(state: &LandingState, back: &[Reason]) -> Vec<Reason> {
    let mut wait = Vec::new();
    if state.draft {
        wait.push(reason("DRAFT", "Marked as a draft in its title"));
    }
    wait.extend(
        (state.requirements.iter())
            .filter(|r| r.state == RequirementState::Waiting)
            .map(|r| reason("GATES", format!("{}: {}", r.name, r.why))),
    );
    // Not ready with nothing to say still holds.
    if !state.gates_ready && back.is_empty() && !wait.iter().any(|r| r.code == "GATES") {
        wait.push(reason("GATES", "Its gates are not ready"));
    }
    wait.extend(evidence(state));
    if state.unresolved_comments {
        let why = "Unresolved review comments: resolve them first";
        wait.push(reason("COMMENTS", why));
    }
    if !state.base_exists {
        wait.push(reason("NO_BASE", "Its base branch does not exist"));
    }
    if let Some(by) = &state.paused_by {
        wait.push(reason(
            AUTOMATION_PAUSED,
            format!("Automation is paused by {by}"),
        ));
    }
    if state.outside_grant {
        let why = "It brings paths outside the grant of a path-limited token that worked on it";
        wait.push(reason("OUTSIDE_GRANT", why));
    }
    wait.extend(
        state
            .legal_hold
            .iter()
            .map(|w| reason("LEGAL_HOLD", w.clone())),
    );
    wait.extend(
        state
            .repo_full
            .iter()
            .map(|w| reason("REPO_FULL", w.clone())),
    );
    wait.extend(state.ahead.iter().map(|ahead| {
        let on = ahead.paths.join(", ");
        let why = format!(
            "Landing {} is ahead in the queue on {on}: it lands first",
            ahead.landing
        );
        reason(SEPARATION, why)
    }));
    wait
}

/// The decision. The same state always gives the same answer.
pub fn clearance(state: &LandingState) -> Clearance {
    let mut back = go_arounds(state);
    let mut wait = holds(state, &back);
    if !back.is_empty() {
        back.append(&mut wait);
        return Clearance::GoAround { reasons: back };
    }
    if wait.is_empty() {
        Clearance::Cleared
    } else {
        Clearance::Hold { reasons: wait }
    }
}

/// An attempt the rules cleared that still did not land, as the job reported it: the merge
/// conflicted, or something arrived first.
pub fn attempt_failed(code: &str, why: &str) -> Clearance {
    let reasons = vec![reason(code, why)];
    if GOES_AROUND.contains(&code) {
        Clearance::GoAround { reasons }
    } else {
        Clearance::Hold { reasons }
    }
}
