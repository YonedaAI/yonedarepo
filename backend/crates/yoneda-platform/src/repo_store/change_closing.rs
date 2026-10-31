//! A change whose branch is deleted can never land: it closes in the delete's transaction,
//! as a close by whoever deleted the branch, and a comment says why (`changes` has no column
//! for a reason). Reopening stays refused until the branch exists again.
use super::{change_hooks, changes};
use crate::storage::SqlStore;
use serde_json::json;
use yoneda_core::{Result, git_object::ObjectId};

/// Called while the ref still names `head`, so the close's event carries that commit.
pub(super) fn branch_deleted<S: SqlStore>(
    db: &S,
    refname: &str,
    head: &ObjectId,
    principal: &str,
    now: i64,
) -> Result<()> {
    let branch = refname.strip_prefix("refs/heads/").unwrap_or(refname);
    let Some(number) = changes::open_on(db, branch)? else {
        return Ok(());
    };
    db.query(
        "UPDATE changes SET status='closed',updated_at=? WHERE number=?",
        &[json!(now), json!(number)],
    )?;
    db.query(
        "INSERT INTO change_comments(change_number,commit_id,body,principal,at) VALUES(?,?,?,?,?)",
        &[
            json!(number),
            json!(head.hex()),
            json!(format!("Closed: the branch {branch} was deleted.")),
            json!(principal),
            json!(now),
        ],
    )?;
    let change = changes::get(db, number)?;
    change_hooks::notify(db, "change.closed", "closed", &change, None, principal, now)
}
