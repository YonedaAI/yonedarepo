//! The rules: all that stands between a Landing's head and the platform landing it. Stricter
//! than a person's landing, who can weigh what a rule can't: every hold is here because landing
//! with nobody watching should need more. `land_gates::gates` decides checks, approvals and
//! rejections as it does for anyone.
use crate::repo_store::change_gates::{ClearanceHold, comments, policy};
use crate::repo_store::change_gates::{GateRequirement, GateState};
use crate::repo_store::rows::{self, CommitRow, Settings};
use crate::repo_store::{break_glass, grants, land_gates, merging};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, txlog::OccOutcome};

/// Title prefixes that mark a draft (`readyForReview`, shared/managed-agents.ts).
const DRAFT: [&str; 4] = ["draft:", "wip:", "[wip]", "[draft]"];

pub(super) fn hold(code: &str, reason: String) -> ClearanceHold {
    ClearanceHold {
        code: code.to_owned(),
        reason,
    }
}

fn requirements<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<Vec<GateRequirement>> {
    let base = refname.strip_prefix("refs/heads/").unwrap_or(refname);
    policy(db, &commit.id, base, settings, true)
}

/// The requirements that decided a landing, for its record.
pub(super) fn deciding_gates<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<Value> {
    Ok(json!(requirements(db, commit, refname, settings)?))
}

/// Everything in the way of `commit`, the head of `change`, landing on `refname`. Empty: it may
/// land. The policy's gates come first, so what a person can do about it reads first.
pub(super) fn holds<S: SqlStore>(
    db: &S,
    change: &Value,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<Vec<ClearanceHold>> {
    let mut held = Vec::new();
    let title = change["title"].as_str().unwrap_or_default().to_lowercase();
    if DRAFT.iter().any(|prefix| title.starts_with(prefix)) {
        held.push(hold("DRAFT", "Marked as a draft in its title".to_owned()));
    }
    let gate = land_gates::gates(db, commit, refname, settings)?;
    gates(db, commit, refname, settings, &gate, &mut held)?;
    evidence(change, &gate, settings, &mut held);
    failed_checks(db, commit, settings, &mut held)?;
    if comments(db, &change["number"])?.state != GateState::Ready {
        held.push(hold(
            "COMMENTS",
            "Unresolved review comments: resolve them first".to_owned(),
        ));
    }
    conflict(db, commit, refname, &mut held)?;
    if let Some(pause) = break_glass::paused(db)? {
        let by = pause["actor"].as_str().unwrap_or("the owner");
        held.push(hold(
            "AUTOMATION_PAUSED",
            format!("Automation is paused by {by}"),
        ));
    }
    if outside_a_grant(db, change, commit, refname)? {
        held.push(hold(
            "OUTSIDE_GRANT",
            "It brings paths outside the grant of a path-limited token that worked on it"
                .to_owned(),
        ));
    }
    Ok(held)
}

/// `land_gates::gates`, as the page words it. Not ready with nothing to say still holds.
fn gates<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
    gate: &Value,
    held: &mut Vec<ClearanceHold>,
) -> Result<()> {
    if gate["ready"] == true {
        return Ok(());
    }
    let before = held.len();
    for r in requirements(db, commit, refname, settings)? {
        if r.state != GateState::Ready {
            held.push(hold("GATES", format!("{}: {}", r.name, r.why)));
        }
    }
    if gate["open_findings"].as_u64().unwrap_or(0) > 0 {
        held.push(hold(
            "FINDINGS",
            format!("{} unresolved agent findings", gate["open_findings"]),
        ));
    }
    if held.len() == before {
        held.push(hold("GATES", "Its gates are not ready".to_owned()));
    }
    Ok(())
}

/// Something has to have cleared it. Rules that ask for nothing would make every push land, and
/// `write` alone would be `land`. A fork's work is anyone's, so it needs an approval of its head
/// whatever else the rules accept.
fn evidence(change: &Value, gate: &Value, settings: &Settings, held: &mut Vec<ClearanceHold>) {
    let approved = gate["approvals"].as_u64().unwrap_or(0) > 0;
    if change["source_repo"].is_string() {
        if !approved {
            held.push(hold(
                "FORK_NEEDS_APPROVAL",
                "A Landing from a fork lands only with an approval of its head".to_owned(),
            ));
        }
        return;
    }
    let required = !settings.policy.required_checks.is_empty();
    if !approved && !required && gate["auto_approved"] != true {
        held.push(hold(
            "NOTHING_REQUIRED",
            "The landing rules ask for no approval or check, so nothing clears it".to_owned(),
        ));
    }
}

/// A failed check on the head, required or not. An agent that reached its `block_at` reports
/// this way, and the rules may not list it.
fn failed_checks<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    settings: &Settings,
    held: &mut Vec<ClearanceHold>,
) -> Result<()> {
    let failed = db.query(
        "SELECT name FROM checks WHERE commit_id=? AND policy_digest=? AND status='fail' \
         ORDER BY name",
        &[json!(commit.id.hex()), json!(settings.policy_digest)],
    )?;
    for row in failed {
        let name = row["name"].as_str().unwrap_or_default();
        if !settings.policy.required_checks.iter().any(|r| r == name) {
            held.push(hold("CHECK_FAILED", format!("{name} failed on this head")));
        }
    }
    Ok(())
}

/// A base that is gone, or one that changed what this head read. Overlapping edits show only
/// when the merge is tried; the ticket then fails with them.
fn conflict<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    held: &mut Vec<ClearanceHold>,
) -> Result<()> {
    let Some(head) = rows::projected_ref(db, refname)? else {
        held.push(hold("NO_BASE", format!("{refname} does not exist")));
        return Ok(());
    };
    if merging::on_head(db, commit, &head)? {
        return Ok(());
    }
    match merging::occ(db, commit, refname)? {
        OccOutcome::Rebase { .. } | OccOutcome::Merge { .. } => {}
        other => held.push(hold(
            "CONFLICT",
            merging::outcome_error(refname, &head, other).message,
        )),
    }
    Ok(())
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
