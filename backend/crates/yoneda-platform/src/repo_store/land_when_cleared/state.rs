//! What is true of a Landing's head: every fact CTC decides on (`platform_ctc`), read from this
//! database. Nothing here decides. Stricter than a person's landing, who can weigh what a rule
//! can't, so it gathers more than `land_gates::gates`, which judges checks, approvals and
//! rejections as it does for anyone.
use crate::platform_ctc::{LandingState, Requirement, RequirementState, RiskScore};
use crate::repo_store::change_gates::{GateState, comments, policy};
use crate::repo_store::rows::{self, CommitRow, Settings};
use crate::repo_store::{break_glass, capacity, grants, land_gates, legal_hold, merging};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId, txlog::OccOutcome};

/// Title prefixes that mark a draft (`readyForReview`, shared/managed-agents.ts).
const DRAFT: [&str; 4] = ["draft:", "wip:", "[wip]", "[draft]"];
/// Approvers named in a Landing's state.
const MAX_APPROVERS: u64 = 16;

/// What only the adapter can answer, when it is asked: `Some`, the command with the legal
/// hold's answer and the storage limit it passes. The page and a queued ticket have none.
pub(super) type Answers<'a> = Option<&'a Value>;

fn requirements<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<Vec<Requirement>> {
    let base = refname.strip_prefix("refs/heads/").unwrap_or(refname);
    Ok(policy(db, &commit.id, base, settings, true)?
        .into_iter()
        .map(|r| Requirement {
            state: match r.state {
                GateState::Ready => RequirementState::Ready,
                GateState::Waiting => RequirementState::Waiting,
                GateState::Blocked => RequirementState::Blocked,
            },
            name: r.name,
            why: r.why,
        })
        .collect())
}

fn approvers<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Vec<String>> {
    let rows = db.query(
        "SELECT principal FROM reviews WHERE commit_id=? AND decision='approve' \
         ORDER BY recorded_at LIMIT ?",
        &[json!(id.hex()), json!(MAX_APPROVERS)],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| row["principal"].as_str().map(str::to_owned))
        .collect())
}

/// Failed on the head and not required: required ones are the policy's gates.
fn failed_checks<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    settings: &Settings,
) -> Result<Vec<String>> {
    let failed = db.query(
        "SELECT name FROM checks WHERE commit_id=? AND policy_digest=? AND status='fail' \
         ORDER BY name",
        &[json!(commit.id.hex()), json!(settings.policy_digest)],
    )?;
    Ok(failed
        .iter()
        .filter_map(|row| row["name"].as_str())
        .filter(|name| !settings.policy.required_checks.iter().any(|r| r == name))
        .map(str::to_owned)
        .collect())
}

/// Whether the base changed what this head read. Overlapping edits show only when the merge is
/// tried; the ticket then fails with them.
fn conflict<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    head: &ObjectId,
) -> Result<Option<String>> {
    if merging::on_head(db, commit, head)? || merging::reads_untouched(db, commit, refname)? {
        return Ok(None);
    }
    Ok(match merging::occ(db, commit, refname)? {
        OccOutcome::Rebase { .. } | OccOutcome::Merge { .. } => None,
        other => Some(merging::outcome_error(refname, head, other).message),
    })
}

/// The newest move of the Landing's branch: who put this head there.
fn last_mover<S: SqlStore>(db: &S, change: &Value) -> Result<Option<String>> {
    let branch = change["branch"].as_str().unwrap_or_default();
    let newest = db.query(
        "SELECT entry FROM txlog WHERE refname=? ORDER BY version DESC LIMIT 1",
        &[json!(format!("refs/heads/{branch}"))],
    )?;
    let entry = newest.first().and_then(|row| {
        serde_json::from_str::<yoneda_core::txlog::TxEntry>(row["entry"].as_str()?).ok()
    });
    Ok(entry.map(|e| e.actor))
}

/// Whether a path-limited token that opened the Landing, wrote its head or moved its branch
/// there has a grant short of all it would bring. A change is off-limits to such a token
/// through the API (`whole_repository`), but a push opens one for it (`auto_landing`). The walk
/// is the one a landing under that grant would take, so a merge or a walk past its bound proves
/// nothing and holds. A revoked token's work is judged by the grant it had.
fn outside_a_grant<S: SqlStore>(
    db: &S,
    change: &Value,
    commit: &CommitRow,
    refname: &str,
) -> Result<bool> {
    let author = change["author"].as_str().map(str::to_owned);
    let names = [
        author,
        Some(commit.principal.clone()),
        last_mover(db, change)?,
    ];
    let touches = rows::touches(db, &commit.id)?;
    for name in names
        .iter()
        .flatten()
        .filter_map(|p| p.strip_prefix("token:"))
    {
        let row = db.query("SELECT paths FROM tokens WHERE name=?", &[json!(name)])?;
        let Some(paths) = row.first().and_then(|r| r["paths"].as_str()) else {
            continue;
        };
        let grant = Some(serde_json::from_str(paths).map_err(|_| rows::corrupt("grant"))?);
        match grants::require_landing(db, commit, &touches, refname, &grant) {
            Ok(()) => {}
            Err(Error { code, .. }) if code == "FORBIDDEN" => return Ok(true),
            Err(other) => return Err(other),
        }
    }
    Ok(false)
}

/// The state of `commit`, the head of `change`, landing on `refname`. `risk` as the caller has
/// it, since only the adapter can read a diff.
pub(super) fn landing_state<S: SqlStore>(
    db: &S,
    change: &Value,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
    answers: Answers,
    risk: Option<RiskScore>,
) -> Result<LandingState> {
    let title = change["title"].as_str().unwrap_or_default().to_lowercase();
    let gate = land_gates::gates(db, commit, refname, settings)?;
    let base_head = rows::projected_ref(db, refname)?;
    let conflict = match &base_head {
        Some(head) => conflict(db, commit, refname, head)?,
        None => None,
    };
    let mut state = LandingState {
        draft: DRAFT.iter().any(|prefix| title.starts_with(prefix)),
        gates_ready: gate["ready"] == true,
        requirements: requirements(db, commit, refname, settings)?,
        open_findings: gate["open_findings"].as_u64().unwrap_or(0),
        approvals: gate["approvals"].as_u64().unwrap_or(0),
        approved_by: approvers(db, &commit.id)?,
        auto_approved: gate["auto_approved"] == true,
        rules_ask: !settings.policy.required_checks.is_empty(),
        from_fork: change["source_repo"].is_string(),
        failed_checks: failed_checks(db, commit, settings)?,
        unresolved_comments: comments(db, &change["number"])?.state != GateState::Ready,
        base_exists: base_head.is_some(),
        conflict,
        paused_by: break_glass::paused(db)?
            .map(|p| p["actor"].as_str().unwrap_or("the owner").to_owned()),
        outside_grant: outside_a_grant(db, change, commit, refname)?,
        legal_hold: None,
        repo_full: None,
        risk,
        ahead: Vec::new(),
    };
    if let Some(c) = answers {
        // Not answered yet: the adapter asks the owner's authority and sends it again.
        match legal_hold::require_free(c, &settings.workspace) {
            Err(e) if e.code == "LEGAL_HOLD" => state.legal_hold = Some(e.message),
            other => other?,
        }
        if capacity::landing_refused(db, c, refname, &commit.id)? {
            state.repo_full = Some(capacity::refusal().message);
        }
    }
    Ok(state)
}
