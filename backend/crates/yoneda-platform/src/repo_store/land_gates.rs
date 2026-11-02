//! Who may land where: the scope a branch lands with, and the gates (approvals, checks,
//! review classes) a commit must pass before it lands on a protected branch.
use super::land_tickets::landed_version;
use super::rows::{self, CommitRow, Settings};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// Commits a walk over what a landing would bring covers at most, the head included.
pub(super) const WALK: usize = 256;

/// Branch policy: a protected ref (`main`, `release`, `release/*`) lands with the `land` scope
/// and only once its gates pass; any other branch lands with `write` and no gates, as
/// `repo_branch_set` already moves it with `write`.
pub fn scope(refname: &str) -> &'static str {
    if rows::protected(refname) {
        "land"
    } else {
        "write"
    }
}

/// Refuses a landing on a protected ref until the commit's gates pass (see `scope`).
pub(super) fn require_gates<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<()> {
    if !rows::protected(refname) {
        return Ok(());
    }
    let gate = gates(db, commit, refname, settings)?;
    if gate["ready"] != true {
        return Err(Error::new(
            "NOT_READY",
            format!("Commit cannot land yet: {}", why_not(&gate)),
        ));
    }
    Ok(())
}

fn names(list: &Value) -> String {
    let names: Vec<&str> = list
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    names.join(", ")
}

/// A gate's refusal in words, the holdup that matters most first: `refusalReason` in the
/// Worker reads the same words back for the usage record.
pub(super) fn why_not(gate: &Value) -> String {
    let mut why = Vec::new();
    if gate["rejected"] == true {
        why.push("a reviewer rejected it".to_owned());
    }
    let failing = names(&gate["failing_checks"]);
    if !failing.is_empty() {
        why.push(format!("checks failed: {failing}"));
    }
    match gate["open_findings"].as_u64().unwrap_or(0) {
        0 => {}
        1 => why.push("1 open finding".to_owned()),
        many => why.push(format!("{many} open findings")),
    }
    let missing = names(&gate["missing_checks"]);
    if !missing.is_empty() {
        why.push(format!("waiting for checks: {missing}"));
    }
    let (have, need) = (
        gate["approvals"].as_u64().unwrap_or(0),
        gate["approvals_required"].as_u64().unwrap_or(0),
    );
    if have < need && gate["auto_approved"] != true {
        why.push(match need {
            1 => format!("needs 1 approval from another person, has {have}"),
            _ => format!("needs {need} approvals from other people, has {have}"),
        });
    }
    if why.is_empty() {
        "the landing rules are not met".to_owned()
    } else {
        why.join("; ")
    }
}

/// A commit's review class: its `overall` and `files`, when one is recorded.
fn class_of<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Option<Value>> {
    Ok(db
        .query(
            "SELECT overall,files FROM commit_classes WHERE commit_id=?",
            &[json!(id.hex())],
        )?
        .into_iter()
        .next())
}

/// Whether every file of a recorded class is in an auto-approvable class.
fn clears(class: &Value, settings: &Settings) -> bool {
    serde_json::from_str::<Vec<Value>>(class["files"].as_str().unwrap_or("[]")).is_ok_and(|files| {
        !files.is_empty()
            && files.iter().all(|f| {
                f["class"]
                    .as_str()
                    .is_some_and(|c| settings.policy.auto_approve.iter().any(|a| a == c))
            })
    })
}

/// Whether every commit under `commit` that landing on `refname` would bring passes `passes`:
/// `walk_until` it meets the ref (its head, its first-parent chain, or a commit landed on it).
pub(super) fn older_commits_pass<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    passes: impl Fn(&ObjectId) -> Result<bool>,
) -> Result<bool> {
    let head = rows::projected_ref(db, refname)?;
    let meets = |parent: &ObjectId| {
        Ok(head == Some(*parent)
            || super::ref_chain::depth(db, refname, parent)?.is_some()
            || landed_version(db, parent, refname)?.is_some())
    };
    walk_until(db, commit, meets, passes)
}

/// Whether every commit under `commit` passes `passes`, walking single parents down to one
/// that `meets` the target. A merge, a parent not recorded, or more than `WALK` commits
/// proves nothing, so none of those pass.
pub(super) fn walk_until<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    meets: impl Fn(&ObjectId) -> Result<bool>,
    passes: impl Fn(&ObjectId) -> Result<bool>,
) -> Result<bool> {
    let mut parents = commit.parents.clone();
    for _ in 0..WALK {
        let parent = match parents.as_slice() {
            [] => return Ok(true),
            [parent] => *parent,
            _ => return Ok(false),
        };
        if meets(&parent)? {
            return Ok(true);
        }
        let Some(row) = rows::commit_row(db, &parent)? else {
            return Ok(false);
        };
        if !passes(&parent)? {
            return Ok(false);
        }
        parents = row.parents;
    }
    Ok(false)
}

/// Why a commit can or cannot land on `refname` under the current policy.
pub fn gates<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<Value> {
    let id = &commit.id;
    let reviews = db.query(
        "SELECT decision FROM reviews WHERE commit_id=?",
        &[json!(id.hex())],
    )?;
    let approvals = super::reviewers::approvals(db, id)?;
    let rejected = reviews.iter().any(|r| r["decision"] == "reject");
    let checks = db.query(
        "SELECT name,status FROM checks WHERE commit_id=? AND policy_digest=?",
        &[json!(id.hex()), json!(settings.policy_digest)],
    )?;
    let status = |name: &str| {
        checks
            .iter()
            .find(|c| c["name"] == name)
            .map(|c| c["status"].clone())
    };
    let missing: Vec<&String> = settings
        .policy
        .required_checks
        .iter()
        .filter(|n| status(n).is_none())
        .collect();
    let failing: Vec<&String> = settings
        .policy
        .required_checks
        .iter()
        .filter(|n| status(n).is_some_and(|s| s == "fail"))
        .collect();
    // Semantic approval: a classified change whose every file is in an auto-approvable
    // class satisfies the approval count, and only if all it would land is too. Unclassified
    // or unknown changes, or a walk that proves nothing, need a human. `review_class` stays
    // the commit's own.
    let class = class_of(db, id)?;
    let auto_approved = class.as_ref().is_some_and(|c| clears(c, settings))
        && older_commits_pass(db, commit, refname, |older| {
            Ok(class_of(db, older)?.is_some_and(|class| clears(&class, settings)))
        })?;
    let class = class.map(|c| c["overall"].clone());
    // Off, the answer holds no such field and this costs no read.
    let findings = settings
        .auto_landings
        .findings_block
        .then(|| super::go_around::agent_findings(db, id, refname))
        .transpose()?;
    let ready = !rejected
        && (auto_approved || approvals >= settings.policy.approvals as usize)
        && missing.is_empty()
        && failing.is_empty()
        && findings.unwrap_or(0) == 0;
    let mut gate = json!({
        "ready": ready, "approvals": approvals, "approvals_required": settings.policy.approvals,
        "review_class": class, "auto_approved": auto_approved,
        "rejected": rejected, "missing_checks": missing, "failing_checks": failing,
    });
    if let Some(findings) = findings {
        gate["open_findings"] = json!(findings);
    }
    Ok(gate)
}
