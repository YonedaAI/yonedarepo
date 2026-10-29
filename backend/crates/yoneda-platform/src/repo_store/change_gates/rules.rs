//! The rules behind each requirement: required checks and approvals as landing decides them
//! (`land_gates::gates`), unresolved review comments, and freshness against the base.
use super::{GateKind, GateRequirement, GateState, requirement};
use crate::repo_store::{land_gates, rows};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::HashSet;
use yoneda_core::{
    Result,
    git_object::{ObjectId, merge_bases},
};

/// First-parent commits counted when telling how far the base moved on.
const BEHIND_LIMIT: usize = 100;

fn plural(n: usize, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// Each required check and the approvals, as landing decides them (`land_gates::gates`).
pub(super) fn policy<S: SqlStore>(
    db: &S,
    id: &ObjectId,
    settings: &rows::Settings,
    enforced: bool,
) -> Result<Vec<GateRequirement>> {
    let gate = land_gates::gates(db, id, settings)?;
    let key = [json!(id.hex()), json!(settings.policy_digest)];
    let checks = db.query(
        "SELECT name,status,principal FROM checks WHERE commit_id=? AND policy_digest=?",
        &key,
    )?;
    let runs = db.query(
        "SELECT name,status FROM check_runs WHERE commit_id=? AND policy_digest=? \
         AND status IN ('queued','running')",
        &key,
    )?;
    let mut out = Vec::new();
    for name in &settings.policy.required_checks {
        let reported = checks.iter().find(|c| c["name"] == name.as_str());
        let run = runs.iter().find(|r| r["name"] == name.as_str());
        let by = |c: &Value| {
            c["principal"]
                .as_str()
                .unwrap_or("a check poster")
                .to_owned()
        };
        let (state, why) = match (reported, run) {
            (Some(c), _) if c["status"] == "pass" => {
                (GateState::Ready, format!("Passed ({})", by(c)))
            }
            (Some(c), _) if c["status"] == "fail" => (
                GateState::Blocked,
                format!("Failed ({}); a new passing result is needed", by(c)),
            ),
            (_, Some(r)) => (
                GateState::Waiting,
                format!(
                    "A platform run is {}",
                    r["status"].as_str().unwrap_or("queued")
                ),
            ),
            _ => (
                GateState::Waiting,
                "Not reported for this commit yet".to_owned(),
            ),
        };
        out.push(requirement(GateKind::Check, name, state, why, enforced));
    }
    let approvals = gate["approvals"].as_u64().unwrap_or(0);
    let required = gate["approvals_required"].as_u64().unwrap_or(0);
    let (state, why) = if gate["rejected"] == true {
        let rejection = db.query(
            "SELECT principal,reason FROM reviews WHERE commit_id=? AND decision='reject' \
             ORDER BY recorded_at DESC LIMIT 1",
            &[json!(id.hex())],
        )?;
        let r = rejection.first().cloned().unwrap_or(Value::Null);
        let reason = r["reason"]
            .as_str()
            .map(|s| format!(": {s}"))
            .unwrap_or_default();
        let who = r["principal"].as_str().unwrap_or("a reviewer");
        (GateState::Blocked, format!("Rejected by {who}{reason}"))
    } else if gate["auto_approved"] == true {
        (
            GateState::Ready,
            "Auto-approved by policy (review class)".to_owned(),
        )
    } else if required == 0 {
        (GateState::Ready, "No approval required".to_owned())
    } else if approvals >= required {
        (
            GateState::Ready,
            format!("{approvals} of {required} approvals"),
        )
    } else {
        (
            GateState::Waiting,
            format!(
                "{approvals} of {required} approvals; needs {} more, not by the head's author",
                required - approvals
            ),
        )
    };
    out.push(requirement(
        GateKind::Approvals,
        "Approvals",
        state,
        why,
        enforced,
    ));
    Ok(out)
}

/// Unresolved comments anchored to the diff (general discussion is not counted).
pub(super) fn comments<S: SqlStore>(db: &S, number: &Value) -> Result<GateRequirement> {
    let open = db.query(
        "SELECT COUNT(*) AS n FROM change_comments WHERE change_number=? AND path IS NOT NULL \
         AND resolved_at IS NULL",
        std::slice::from_ref(number),
    )?;
    let n = open.first().and_then(|r| r["n"].as_u64()).unwrap_or(0) as usize;
    Ok(if n == 0 {
        requirement(
            GateKind::Comments,
            "Review comments",
            GateState::Ready,
            "No unresolved review comments".to_owned(),
            false,
        )
    } else {
        requirement(
            GateKind::Comments,
            "Review comments",
            GateState::Waiting,
            format!(
                "{} unresolved review {}; landing does not wait for them",
                n,
                if n == 1 { "comment" } else { "comments" }
            ),
            false,
        )
    })
}

/// The head against its base's latest commit: up to date, or how far the base moved on.
pub(super) fn freshness<S: SqlStore>(
    db: &S,
    head: &ObjectId,
    base: &str,
) -> Result<GateRequirement> {
    let refname = format!("refs/heads/{base}");
    let tip = db.query("SELECT commit_id FROM refs WHERE name=?", &[json!(refname)])?;
    let Some(tip) = tip.first().and_then(|r| r["commit_id"].as_str()) else {
        return Ok(requirement(
            GateKind::Freshness,
            "Base",
            GateState::Blocked,
            format!("The base branch {base} does not exist"),
            true,
        ));
    };
    let tip = ObjectId::parse(tip)?;
    let graph = rows::RecordedGraph(db);
    let bases: HashSet<ObjectId> = merge_bases(&graph, head, &tip)?.into_iter().collect();
    if bases.contains(&tip) {
        return Ok(requirement(
            GateKind::Freshness,
            "Base",
            GateState::Ready,
            format!("Up to date with {base}"),
            false,
        ));
    }
    // First-parent commits of the base since the branch's merge base, up to a bound.
    let floor = bases
        .iter()
        .map(|b| rows::recorded(db, b).map(|r| r.generation))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .max()
        .unwrap_or(0);
    let mut behind = 0;
    let mut at = Some(tip);
    while let Some(id) = at.filter(|id| !bases.contains(id)) {
        let row = rows::recorded(db, &id)?;
        if row.generation <= floor || behind >= BEHIND_LIMIT {
            break;
        }
        behind += 1;
        at = row.parents.first().copied();
    }
    let count = if behind >= BEHIND_LIMIT {
        format!("{BEHIND_LIMIT}+ new commits")
    } else {
        plural(behind, "new commit")
    };
    Ok(requirement(
        GateKind::Freshness,
        "Base",
        GateState::Waiting,
        format!(
            "{base} has {count} since this branch; landing merges them on the server (overlapping edits are refused)"
        ),
        false,
    ))
}
