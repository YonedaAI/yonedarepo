//! Closing and reopening a change. A change whose branch is deleted can never land: it
//! closes in the delete's transaction, as a close by whoever deleted the branch, and a comment
//! says why (`changes` has no column for a reason). Reopening stays refused until the branch
//! exists again.
use super::auth::Actor;
use super::{change_hooks, changes};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId};

/// `repo_change_close` and `repo_change_reopen {number}`: by the change's author, the owner
/// or a holder of the `land` scope.
pub fn set_open<S: SqlStore>(db: &S, c: &Value, actor: &Actor, open: bool) -> Result<Value> {
    changes::whole_repository(actor)?;
    let change = changes::get(db, changes::number_of(c)?)?;
    if change["author"] != actor.principal.as_str() && !actor.owner && !actor.can("land") {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the change's author, the owner or a lander can close or reopen it",
        ));
    }
    let (from, to) = if open {
        ("closed", "open")
    } else {
        ("open", "closed")
    };
    if change["status"] == to {
        return Ok(change);
    }
    if change["status"] != from {
        return Err(Error::new(
            "CONFLICT",
            format!("Change #{} is {}", change["number"], change["status"]),
        ));
    }
    let branch = change["branch"].as_str().unwrap_or_default();
    if open {
        changes::working_branch(db, branch)?;
        changes::base_branch(db, change["base"].as_str(), branch)?;
        if let Some(number) = changes::open_on(db, branch)? {
            return Err(changes::already_open(branch, number));
        }
    }
    let now = number(c, "now")?;
    db.query(
        "UPDATE changes SET status=?,updated_at=? WHERE number=?",
        &[json!(to), json!(now), change["number"].clone()],
    )?;
    let change = changes::get(db, change["number"].as_i64().unwrap_or_default())?;
    let (event, action) = if open {
        ("change.opened", "reopened")
    } else {
        ("change.closed", "closed")
    };
    change_hooks::notify(db, event, action, &change, None, &actor.principal, now)?;
    Ok(change)
}

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
