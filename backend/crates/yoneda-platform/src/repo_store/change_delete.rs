//! Deleting a change request: tidying away a closed one (test changes, abandoned
//! proposals). Only a closed change goes: an open one is closed first, and a landed one is
//! history (its landing, commits and log entries are never touched). Only its author or
//! the owner deletes it, not a lander, since it is the author's proposal. The change and
//! its comments are removed in one transaction with a `change.deleted` event for `change`
//! hooks; change numbers are never reused (AUTOINCREMENT).
use super::auth::Actor;
use super::{change_hooks, changes};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// `repo_change_delete {number}`.
pub fn delete<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    changes::whole_repository(actor)?;
    let change = changes::get(db, changes::number_of(c)?)?;
    if change["author"] != actor.principal.as_str() && !actor.owner {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the change's author or the owner can delete it",
        ));
    }
    match change["status"].as_str() {
        Some("closed") => {}
        Some("open") => {
            return Err(Error::new(
                "CONFLICT",
                format!("Change #{} is open; close it first", change["number"]),
            ));
        }
        _ => {
            return Err(Error::new(
                "CONFLICT",
                format!(
                    "Change #{} is {}; landed changes stay as history",
                    change["number"], change["status"]
                ),
            ));
        }
    }
    let key = [change["number"].clone()];
    db.query("DELETE FROM change_comments WHERE change_number=?", &key)?;
    db.query("DELETE FROM changes WHERE number=?", &key)?;
    let now = number(c, "now")?;
    change_hooks::notify(
        db,
        "change.deleted",
        "deleted",
        &change,
        None,
        &actor.principal,
        now,
    )?;
    Ok(json!({ "number": change["number"], "deleted": true }))
}
