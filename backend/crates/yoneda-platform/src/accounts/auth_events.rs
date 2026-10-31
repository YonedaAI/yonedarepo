//! Sign-ins on the person's own `workspace_events`, while the adapter's `audit_log` switch
//! is on. Never flooded: the adapter's limiter is per address and the account's own limit
//! still allows ten attempts a minute, so failed logins share one row an hour, and only the
//! newest `KEEP` sign-in rows stay. Sign-ins never reach an organization's log.
use super::*;

const KEEP: i64 = 1000;
const FAILED_WINDOW: i64 = 60 * 60 * 1000;
const FAILED: &str = "login_failed";

fn on(c: &Value) -> bool {
    c["audit_log"] == true
}

pub(super) fn note<S: SqlStore>(
    db: &S,
    c: &Value,
    kind: &str,
    now: i64,
    data: Value,
) -> Result<()> {
    if !on(c) {
        return Ok(());
    }
    audit(db, kind, now, data)?;
    db.query(
        "DELETE FROM workspace_events WHERE kind LIKE 'auth.%' AND seq<(SELECT seq FROM \
         workspace_events WHERE kind LIKE 'auth.%' ORDER BY seq DESC LIMIT 1 OFFSET ?)",
        &[json!(KEEP - 1)],
    )?;
    Ok(())
}

/// A wrong password or recovery code. The first of an hour writes the row, which also says
/// how many more came in the hour before it.
pub(super) fn login_failed<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<()> {
    if !on(c) {
        return Ok(());
    }
    let window = get(db, FAILED).ok();
    let start = window.as_ref().and_then(|w| w["start"].as_i64());
    let count = window.and_then(|w| w["count"].as_i64()).unwrap_or_default();
    if let Some(start) = start.filter(|start| start + FAILED_WINDOW > now) {
        return put(db, FAILED, &json!({ "start": start, "count": count + 1 }));
    }
    note(
        db,
        c,
        "auth.login_failed",
        now,
        json!({ "earlier": (count - 1).max(0) }),
    )?;
    put(db, FAILED, &json!({ "start": now, "count": 1 }))
}

/// `device_noted {approved, client, host}`: the code's authority approved or denied a device;
/// this account's own log says so (the code's instance is gone in ten minutes).
pub(super) fn device_noted<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    let kind = if c["approved"] == true {
        "auth.device_approved"
    } else {
        "auth.device_denied"
    };
    let clean = |key: &str| c[key].as_str().map(super::audit_details::text);
    note(
        db,
        c,
        kind,
        now,
        json!({ "client": clean("client"), "host": clean("host") }),
    )?;
    Ok(json!({ "noted": true }))
}
