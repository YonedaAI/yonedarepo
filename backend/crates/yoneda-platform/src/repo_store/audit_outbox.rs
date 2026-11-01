//! Repository events for an organization's audit log (`accounts/audit_log.rs`): each commits
//! here in one transaction with the change it records, and the adapter copies them across
//! after the answer, settling them here once the log has them. A copy that fails leaves them
//! for the next one, and the log's cursor per source drops a repeat.
//!
//! They wait in `hook_outbox` under a hook id no hook has (`OUTBOX`; ids start at 1), which
//! is an ordered outbox that needs no migration. Every reader there names a hook or joins
//! `hooks`, so an older binary leaves these rows alone, and the one that lists any hook's
//! rows (a repeated delete) would send a job that finds no such hook. The erase wipes them
//! with the table, so while the switch is on it refuses until the log has them all (`waiting`).
//!
//! Only a command carrying the adapter's `_audit` writes, which it sends while `AUDIT_LOG` is
//! on. A row holds what the action said; what enters the log is decided there
//! (`accounts/audit_details.rs`), and whose log it is by the adapter, as a repository doesn't
//! know whether its owner is an org.
use super::rows::{Settings, corrupt};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::Result;

/// The `hook_outbox.hook_id` of audit events.
pub(super) const OUTBOX: i64 = 0;
/// Events handed over at once.
const PAGE: i64 = 100;

/// Whether any event has yet to reach the log.
pub(super) fn waiting<S: SqlStore>(db: &S) -> Result<bool> {
    let row = db.query(
        "SELECT seq FROM hook_outbox WHERE hook_id=? LIMIT 1",
        &[json!(OUTBOX)],
    )?;
    Ok(!row.is_empty())
}

/// Records `kind`, by `actor`, in the caller's transaction. `name` is the repository's, as
/// the change left it.
pub(super) fn record<S: SqlStore>(
    db: &S,
    c: &Value,
    kind: &str,
    actor: &str,
    mut data: Value,
) -> Result<()> {
    if c["_audit"] != "on" {
        return Ok(());
    }
    let named = db.query("SELECT name FROM repo_settings WHERE id='repository'", &[])?;
    data["name"] = named.first().map_or(Value::Null, |r| r["name"].clone());
    data["actor"] = json!(actor);
    data["at"] = json!(number(c, "now")?);
    db.query(
        "INSERT INTO hook_outbox(hook_id,event,payload) VALUES(?,?,?)",
        &[json!(OUTBOX), json!(kind), json!(data.to_string())],
    )?;
    Ok(())
}

/// `repo_audit_pending {limit?}`: the oldest events waiting, and the owner whose log they go
/// to (`workspace`).
pub(super) fn pending<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let limit = c["limit"].as_i64().unwrap_or(PAGE).clamp(1, PAGE);
    let rows = db.query(
        "SELECT seq,event,payload FROM hook_outbox WHERE hook_id=? ORDER BY seq LIMIT ?",
        &[json!(OUTBOX), json!(limit)],
    )?;
    let events = rows
        .iter()
        .map(|row| {
            let payload = row["payload"].as_str().unwrap_or_default();
            let mut data: Value =
                serde_json::from_str(payload).map_err(|_| corrupt("audit event"))?;
            let at = data.as_object_mut().and_then(|d| d.remove("at"));
            Ok(json!({ "seq": row["seq"], "kind": row["event"], "at": at, "data": data }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({ "events": events, "workspace": settings.workspace }))
}

/// `repo_audit_done {through}`: the log has every event up to `through`.
pub(super) fn done<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let through = number(c, "through")?;
    db.query(
        "DELETE FROM hook_outbox WHERE hook_id=? AND seq<=?",
        &[json!(OUTBOX), json!(through)],
    )?;
    Ok(json!({ "through": through }))
}
