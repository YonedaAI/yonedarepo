//! Adopting an automatic Landing. A push opens a row nobody asked for (`origin` = `auto`), so
//! an installed client's push-then-`git_change_create` finds its branch taken. Create claims
//! that row instead: the proposal's title, body, base and author replace the push's, and it
//! answers as a create, `change.opened` included. An explicit row still refuses. `origin` is
//! read from `SELECT *`, so a binary that knows migration 0044 but doesn't apply it runs this
//! on either schema: rollback from wave 2 finds adoption still there.
use super::auth::Actor;
use super::{change_hooks, changes};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::Result;

/// What an adopting create names.
pub(super) struct Proposal<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub base: &'a str,
}

/// Whether change `number` is a push's row nobody has claimed.
pub(super) fn unclaimed<S: SqlStore>(db: &S, number: i64) -> Result<bool> {
    let row = db.query("SELECT * FROM changes WHERE number=?", &[json!(number)])?;
    Ok(row.first().is_some_and(|r| r["origin"] == "auto"))
}

pub(super) fn adopt<S: SqlStore>(
    db: &S,
    number: i64,
    proposal: &Proposal<'_>,
    actor: &Actor,
    now: i64,
) -> Result<Value> {
    db.query(
        "UPDATE changes SET title=?,body=?,base=?,author=?,origin='explicit',updated_at=? WHERE number=?",
        &[
            json!(proposal.title),
            json!(proposal.body),
            json!(proposal.base),
            json!(actor.principal),
            json!(now),
            json!(number),
        ],
    )?;
    let change = changes::get(db, number)?;
    change_hooks::notify(
        db,
        "change.opened",
        "opened",
        &change,
        None,
        &actor.principal,
        now,
    )?;
    Ok(change)
}
