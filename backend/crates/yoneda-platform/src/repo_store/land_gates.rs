//! Who may land where: the scope a branch lands with, and the gates (approvals, checks,
//! review classes) a commit must pass before it lands on a protected branch.
use super::rows::{self, Settings};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

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
    id: &ObjectId,
    refname: &str,
    settings: &Settings,
) -> Result<()> {
    if !rows::protected(refname) {
        return Ok(());
    }
    let gate = gates(db, id, settings)?;
    if gate["ready"] != true {
        return Err(Error::new(
            "NOT_READY",
            format!("Commit cannot land yet: {gate}"),
        ));
    }
    Ok(())
}

/// Why a commit can or cannot land under the current policy.
pub fn gates<S: SqlStore>(db: &S, id: &ObjectId, settings: &Settings) -> Result<Value> {
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
    // class satisfies the approval count. Unclassified or unknown changes never do.
    let classes = db.query(
        "SELECT overall,files FROM commit_classes WHERE commit_id=?",
        &[json!(id.hex())],
    )?;
    let class = classes.first().map(|r| r["overall"].clone());
    let auto_approved = classes.first().is_some_and(|r| {
        serde_json::from_str::<Vec<Value>>(r["files"].as_str().unwrap_or("[]")).is_ok_and(|files| {
            !files.is_empty()
                && files.iter().all(|f| {
                    f["class"]
                        .as_str()
                        .is_some_and(|c| settings.policy.auto_approve.iter().any(|a| a == c))
                })
        })
    });
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
