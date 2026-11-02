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
//! on. A row that can't be handed over is never skipped or dropped: `pending` hands over what
//! came before it and names it, and it stays first in line, with what follows behind it, until
//! an operator sets it aside (`set_aside`). A row holds what the action said; what enters the
//! log is decided there (`accounts/audit_details.rs`), and whose log it is by the adapter, as a
//! repository doesn't know whether its owner is an org.
use super::rows::Settings;
use crate::storage::{SqlStore, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

/// The `hook_outbox.hook_id` of audit events.
pub(super) const OUTBOX: i64 = 0;
/// Events handed over at once.
const PAGE: i64 = 100;
/// The event a set-aside row becomes.
const SET_ASIDE: &str = "audit.row_set_aside";

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

/// A row as the log takes it, or `None` for one it never could (`audit_log::append`).
fn handed_over(row: &Value) -> Option<Value> {
    row["event"]
        .as_str()
        .filter(|kind| !kind.trim().is_empty())?;
    let mut data: Value = serde_json::from_str(row["payload"].as_str()?).ok()?;
    let at = data.as_object_mut()?.remove("at")?;
    at.is_i64()
        .then(|| json!({ "seq": row["seq"], "kind": row["event"], "at": at, "data": data }))
}

/// `repo_audit_pending {limit?}`: the oldest events waiting, the owner whose log they go to
/// (`workspace`), and the `seq` of a row that stopped the page (`corrupt`, null without one).
pub(super) fn pending<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let limit = c["limit"].as_i64().unwrap_or(PAGE).clamp(1, PAGE);
    let rows = db.query(
        "SELECT seq,event,payload FROM hook_outbox WHERE hook_id=? ORDER BY seq LIMIT ?",
        &[json!(OUTBOX), json!(limit)],
    )?;
    let mut corrupt = Value::Null;
    let events: Vec<Value> = rows
        .iter()
        .map_while(|row| {
            let event = handed_over(row);
            if event.is_none() {
                corrupt = row["seq"].clone();
            }
            event
        })
        .collect();
    Ok(json!({ "events": events, "corrupt": corrupt, "workspace": settings.workspace }))
}

/// A row's kind for a reader: only what has the shape of one, as a corrupt row's may be anything.
fn kind_of(row: &Value) -> &str {
    let shaped = |kind: &&str| {
        let allowed = |b: u8| b.is_ascii_lowercase() || b == b'_' || b == b'.';
        kind.len() <= 64 && kind.contains('.') && kind.bytes().all(allowed)
    };
    row["event"].as_str().filter(shaped).unwrap_or("unknown")
}

/// `repo_audit_set_aside {seq, check?, bytes?, operator?}`: an operator's way past a row the log
/// could never take. Only that row, judged here by the rule `pending` applies, so a healthy event
/// can't be reached by any argument. It becomes `audit.row_set_aside` in one statement, same
/// `seq`: the log and what waits behind it move on, and the repair is an event in the row's
/// place. What the row held is gone and is never answered: only its kind, if it has the shape of
/// one, and its size, which the real run must repeat from the dry run (`check`) that showed it.
/// A hold refuses this (`legal_hold`), and so does the switch being off, as nothing would show.
/// `state` says the rest: `corrupt`, `set_aside`, `already` (a repeat), `absent` (no such
/// waiting event: settled since, or never one).
pub(super) fn set_aside<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    if c["_audit"] != "on" {
        return Err(Error::new("CONFLICT", "The audit log is off"));
    }
    let seq = number(c, "seq")?;
    let rows = db.query(
        "SELECT seq,event,payload FROM hook_outbox WHERE hook_id=? AND seq=?",
        &[json!(OUTBOX), json!(seq)],
    )?;
    let Some(row) = rows.first() else {
        return Ok(json!({ "state": "absent", "seq": seq }));
    };
    if row["event"] == SET_ASIDE {
        return Ok(json!({ "state": "already", "seq": seq }));
    }
    if handed_over(row).is_some() {
        return Err(Error::new(
            "CONFLICT",
            "That event is healthy, so it can't be set aside",
        ));
    }
    let (kind, bytes) = (kind_of(row), row["payload"].as_str().map_or(0, str::len));
    let checking = c["check"] == true;
    let state = if checking { "corrupt" } else { "set_aside" };
    let answer = json!({ "state": state, "seq": seq, "kind": kind, "bytes": bytes });
    if checking {
        return Ok(answer);
    }
    if number(c, "bytes")? != bytes as i64 {
        return Err(Error::new(
            "CONFLICT",
            "That row isn't the one the dry run showed: run it again",
        ));
    }
    let named = db.query("SELECT name FROM repo_settings WHERE id='repository'", &[])?;
    let marker = json!({
        "name": named.first().map_or(Value::Null, |r| r["name"].clone()),
        "actor": format!("operator:{}", string(c, "operator")?),
        "at": number(c, "now")?, "row": seq, "of_kind": kind, "bytes": bytes,
    });
    db.query(
        "UPDATE hook_outbox SET event=?,payload=? WHERE hook_id=? AND seq=?",
        &[
            json!(SET_ASIDE),
            json!(marker.to_string()),
            json!(OUTBOX),
            json!(seq),
        ],
    )?;
    Ok(answer)
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
