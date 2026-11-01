//! Who a review counts for. A person reviews as their account (`user:<account>`, by
//! session or personal token alike); a repository token reviews for the account that
//! created it, so nobody approves their own commit through a token they made, and the
//! approval count is of distinct accounts.
//!
//! Deliberately asymmetric: a commit pushed *by* a repository token is authored by that
//! token (`token:<name>`), not by the account that created it, so that account may approve
//! it. Agents push with tokens the owner mints and the human approves their work; resolving
//! the author's token too would leave a one-person repository unable to approve any agent
//! commit. Pinned by tests/self_review.rs.
//!
//! An agent (`agent:<account>/<name>`, a personal token an account's person approved) is the
//! same: its owner may approve what it pushed, and it reviews for its owner. It also never
//! approves another agent of that owner, or two of them could land with nobody looking.
use crate::storage::SqlStore;
use serde_json::json;
use yoneda_core::{Error, Result, git_object::ObjectId};

/// The account an agent's principal belongs to, as that account's principal.
fn agent_owner(principal: &str) -> Option<String> {
    let (account, _) = principal.strip_prefix("agent:")?.split_once('/')?;
    Some(format!("user:{account}"))
}

/// The account `principal` reviews for: a token's creator, an agent's owner, or the principal
/// itself.
fn account<S: SqlStore>(db: &S, principal: &str) -> Result<String> {
    if let Some(owner) = agent_owner(principal) {
        return Ok(owner);
    }
    let Some(name) = principal.strip_prefix("token:") else {
        return Ok(principal.to_owned());
    };
    Ok(db
        .query("SELECT created_by FROM tokens WHERE name=?", &[json!(name)])?
        .first()
        .and_then(|t| t["created_by"].as_str().map(str::to_owned))
        .unwrap_or_else(|| principal.to_owned()))
}

/// Refuses a review by the commit's author, directly or through a token they created.
pub fn require_not_author<S: SqlStore>(db: &S, author: &str, reviewer: &str) -> Result<()> {
    let siblings = agent_owner(reviewer).is_some() && agent_owner(reviewer) == agent_owner(author);
    if reviewer == author || account(db, reviewer)? == author || siblings {
        return Err(Error::new(
            "FORBIDDEN",
            "Authors cannot review their own commit",
        ));
    }
    Ok(())
}

/// Approvals of `id` from distinct accounts other than its author's. A commit the
/// authority has not recorded (a shard record not yet adopted) has no reviews.
pub fn approvals<S: SqlStore>(db: &S, id: &ObjectId) -> Result<usize> {
    let Some(commit) = super::rows::commit_row(db, id)? else {
        return Ok(0);
    };
    let author = commit.principal;
    let rows = db.query(
        "SELECT COUNT(DISTINCT who) AS n FROM (SELECT COALESCE(t.created_by, \
         CASE WHEN r.principal LIKE 'agent:%' \
         THEN 'user:' || substr(r.principal, 7, instr(r.principal, '/') - 7) \
         ELSE r.principal END) AS who FROM reviews r \
         LEFT JOIN tokens t ON r.principal = 'token:' || t.name \
         WHERE r.commit_id=? AND r.decision='approve' AND r.principal<>?) WHERE who<>?",
        &[json!(id.hex()), json!(author), json!(author)],
    )?;
    Ok(rows
        .first()
        .and_then(|r| r["n"].as_u64())
        .unwrap_or_default() as usize)
}
