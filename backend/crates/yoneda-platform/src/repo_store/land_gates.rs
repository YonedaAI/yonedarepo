//! Who may land where: the scope a branch lands with, and the gates (approvals, checks,
//! review classes) a commit must pass before it lands on a protected branch.
use super::land_tickets::landed_version;
use super::rows::{self, CommitRow, Settings};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// Commits an auto-approval walks at most, the head included.
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
            format!("Commit cannot land yet: {gate}"),
        ));
    }
    Ok(())
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

/// Whether every commit under `commit` that landing on `refname` would bring also clears:
/// walks single parents down to where they meet the ref (its head, its first-parent chain,
/// or a commit landed on it). A merge, a commit with no class, a parent not recorded, or
/// more than `WALK` commits proves nothing, so a human approves those.
fn older_commits_clear<S: SqlStore>(
    db: &S,
    commit: &CommitRow,
    refname: &str,
    settings: &Settings,
) -> Result<bool> {
    let head = rows::projected_ref(db, refname)?;
    let mut parents = commit.parents.clone();
    for _ in 0..WALK {
        let parent = match parents.as_slice() {
            [] => return Ok(true),
            [parent] => *parent,
            _ => return Ok(false),
        };
        if head == Some(parent)
            || super::ref_chain::depth(db, refname, &parent)?.is_some()
            || landed_version(db, &parent, refname)?.is_some()
        {
            return Ok(true);
        }
        let Some(row) = rows::commit_row(db, &parent)? else {
            return Ok(false);
        };
        if !class_of(db, &parent)?.is_some_and(|class| clears(&class, settings)) {
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
    // or unknown changes never do. `review_class` stays the commit's own.
    let class = class_of(db, id)?;
    let auto_approved = class.as_ref().is_some_and(|c| clears(c, settings))
        && older_commits_clear(db, commit, refname, settings)?;
    let class = class.map(|c| c["overall"].clone());
    let ready = !rejected
        && (auto_approved || approvals >= settings.policy.approvals as usize)
        && missing.is_empty()
        && failing.is_empty();
    Ok(json!({
        "ready": ready, "approvals": approvals, "approvals_required": settings.policy.approvals,
        "review_class": class, "auto_approved": auto_approved,
        "rejected": rejected, "missing_checks": missing, "failing_checks": failing,
    }))
}
