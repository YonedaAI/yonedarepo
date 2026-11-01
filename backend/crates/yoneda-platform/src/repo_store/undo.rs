//! The undo window: with `REPO_UNDO_DAYS` set, a deletion leaves a tombstone that waits
//! before anything is purged, and until a purge starts the owner can bring it back. The
//! adapter holds the schedule (a sweep of the owner's list, `repo-deleted.ts`), and this
//! authority decides: every command carries the window (`_undo_ms`, never from a client),
//! `deleted_at` plus the window is the due time, and `repo_purge_target` and the erase refuse
//! until then. No command with no window waits, so a purge from before the switch, a failed
//! create taken back or an operator's purge runs at once.
//!
//! The first purge to pass marks the tombstone in one transaction with the check, and a
//! restore needs that mark absent, so the two can never both win, whatever the clock says: a
//! repository past its due time that a legal hold kept from purging still restores. The mark
//! is `policy_digest`, as `erase` marks `object_store`: it needs no migration, an older binary
//! never reads it on a tombstone, and nothing bound to the digest can run again, as a marked
//! tombstone never comes back. `repo_purged` closes it, once, queueing `repo.purged`.
use super::audit_outbox;
use super::auth::Actor;
use super::deletion;
use super::rows::{self, Settings};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// `repo_settings.policy_digest` of a tombstone a purge has reached, and has finished.
const PURGING: &str = "purging";
const PURGED: &str = "purged";

/// Whether a purge has reached this tombstone (a digest of neither name is a real one).
pub(super) fn started(digest: &str) -> bool {
    digest == PURGING || digest == PURGED
}

/// The due time of a repository deleted at `deleted_at`, when the command names a window.
fn due(c: &Value, deleted_at: Option<i64>) -> Option<i64> {
    let window = c["_undo_ms"].as_i64().filter(|ms| *ms > 0)?;
    deleted_at?.checked_add(window)
}

/// The due time of this tombstone, while a purge must wait for it.
pub(super) fn waiting_until(c: &Value, settings: &Settings) -> Option<i64> {
    if settings.purge_started() {
        return None;
    }
    due(c, settings.deleted_at).filter(|at| c["now"].as_i64().is_none_or(|now| now < *at))
}

/// Refuses while the window is open. The message is the due time, so a job that arrives
/// early can put the repository on the schedule.
pub(super) fn require_due(c: &Value, settings: &Settings) -> Result<()> {
    match waiting_until(c, settings) {
        Some(at) => Err(Error::new("NOT_DUE", at.to_string())),
        None => Ok(()),
    }
}

/// Past `require_due`: from here on this tombstone never comes back.
pub(super) fn start_purge<S: SqlStore>(db: &S, settings: &Settings) -> Result<()> {
    if !settings.purge_started() {
        db.query(
            "UPDATE repo_settings SET policy_digest=? WHERE id='repository'",
            &[json!(PURGING)],
        )?;
    }
    Ok(())
}

/// What the adapter lists a tombstone by, deleted at `deleted_at`.
pub(super) fn facts(c: &Value, settings: &Settings, deleted_at: Option<i64>) -> Value {
    json!({
        "name": settings.name,
        "workspace": settings.workspace,
        "visibility": settings.visibility.as_str(),
        "created_at": settings.created_at,
        "parent": settings.parent.as_ref().map(|(repo, _)| repo),
        "deleted_at": deleted_at,
        "purge_at": due(c, deleted_at),
        "purge_started": settings.purge_started(),
    })
}

/// `repo_restore {name?, check?}`: the owner's account brings a tombstone no purge has reached
/// back (`deletion::allowed_when_deleted`), under `name` when it names one. With `check`,
/// changes nothing: the adapter first holds the name and re-registers a fork. Again on a live
/// repository answers `already`, so a retry repeats what an attempt left undone. Only the
/// deletion is undone: its tokens stay revoked.
pub(super) fn restore<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &Settings,
) -> Result<Value> {
    let already = settings.deleted_at.is_none();
    let name = match &c["name"] {
        Value::Null => settings.name.clone(),
        _ if already => settings.name.clone(),
        _ => rows::repo_name(c)?,
    };
    if !already && c["check"] != true {
        db.query(
            "UPDATE repo_settings SET deleted_at=NULL,name=? WHERE id='repository'",
            &[json!(name)],
        )?;
        let previous = (name != settings.name).then_some(&settings.name);
        let event = json!({ "previous": previous });
        audit_outbox::record(db, c, "repo.restored", &actor.principal, event)?;
    }
    let mut answer = facts(c, settings, settings.deleted_at);
    answer["name"] = json!(name);
    answer["already"] = json!(already);
    Ok(answer)
}

/// `repo_purged`: the purge job's last report. Queues `repo.purged` once and answers the hooks
/// with it still to deliver, and the owner whose list it leaves (empty once erased).
pub(super) fn purged<S: SqlStore>(
    db: &S,
    c: &Value,
    actor: &Actor,
    settings: &Settings,
) -> Result<Value> {
    if settings.deleted_at.is_none() {
        return Err(Error::new("NOT_FOUND", "Repository is not deleted"));
    }
    if settings.policy_digest != PURGED && !settings.erased() {
        let now = number(c, "now")?;
        deletion::notify(db, "repo.purged", "purged", &actor.principal, now, None)?;
        db.query(
            "UPDATE repo_settings SET policy_digest=? WHERE id='repository'",
            &[json!(PURGED)],
        )?;
    }
    let hooks: Vec<Value> = db
        .query(
            "SELECT DISTINCT hook_id AS id FROM hook_outbox WHERE event='repo.purged' ORDER BY hook_id",
            &[],
        )?
        .into_iter()
        .map(|r| r["id"].clone())
        .collect();
    Ok(json!({ "hooks": hooks, "workspace": settings.workspace }))
}
