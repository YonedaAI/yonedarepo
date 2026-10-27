//! Webhook delivery state. The platform's delivery job claims a hook's oldest payload
//! under a lease (one in flight per hook, so a hook sees events in order), sends it signed
//! and settles the attempt here. A failure backs off exponentially and keeps the payload
//! first in line (at least once); 50 consecutive failures switch the hook off.
use super::hooks::LOG_SIZE;
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::Result;

/// Longer than the adapter's 10 s send timeout plus its authority calls.
const LEASE_MS: i64 = 30_000;
const MAX_FAILURES: i64 = 50;
const FIRST_BACKOFF_MS: i64 = 10_000;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;

fn hook_id(c: &Value) -> Result<i64> {
    c["hook_id"]
        .as_i64()
        .ok_or_else(|| bad("Missing or invalid hook_id"))
}

/// `repo_hook_claim {hook_id}`: the next payload to send (its body, the signing secret and
/// where), `idle` when there is none (or the hook is gone or off), or `busy` with how long
/// to wait while another attempt holds it or it is backing off.
pub fn claim<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = hook_id(c)?;
    let now = number(c, "now")?;
    let Some(hook) = db
        .query(
            "SELECT repo,url,secret,active FROM hooks WHERE id=?",
            &[json!(id)],
        )?
        .into_iter()
        .next()
    else {
        return Ok(json!({ "idle": true, "reason": "deleted" }));
    };
    if hook["active"] != 1 {
        return Ok(json!({ "idle": true, "reason": "inactive" }));
    }
    let Some(row) = db
        .query(
            "SELECT seq,event,payload,attempts,next_at,lease_until FROM hook_outbox WHERE hook_id=? ORDER BY seq LIMIT 1",
            &[json!(id)],
        )?
        .into_iter()
        .next()
    else {
        return Ok(json!({ "idle": true }));
    };
    if let Some(until) = row["lease_until"].as_i64().filter(|u| *u > now) {
        return Ok(json!({ "busy": true, "leased": true, "retry_after_ms": until - now }));
    }
    let next_at = row["next_at"].as_i64().unwrap_or(0);
    if next_at > now {
        return Ok(json!({ "busy": true, "retry_after_ms": next_at - now }));
    }
    let seq = row["seq"].as_i64().unwrap_or_default();
    let attempt = row["attempts"].as_i64().unwrap_or(0) + 1;
    db.query(
        "UPDATE hook_outbox SET attempts=?,lease_until=? WHERE seq=?",
        &[json!(attempt), json!(now + LEASE_MS), json!(seq)],
    )?;
    let delivery_id = format!("{}.{id}.{seq}", hook["repo"].as_str().unwrap_or_default());
    let mut payload: Value = serde_json::from_str(row["payload"].as_str().unwrap_or_default())
        .map_err(|_| super::rows::corrupt("hook payload"))?;
    payload["delivery_id"] = json!(delivery_id);
    Ok(json!({
        "seq": seq, "attempt": attempt, "delivery_id": delivery_id, "event": row["event"],
        "url": hook["url"], "secret": hook["secret"], "body": payload.to_string(),
    }))
}

/// `repo_hook_settle {hook_id, seq, attempt, ok, status?, ms, error?}`: logs the attempt
/// (keeping the last 50), drops a delivered payload, or schedules the retry and counts the
/// failure. A settle for an attempt that no longer holds the payload (settled already, or
/// claimed again by another job after its lease ran out) is `stale`.
pub fn settle<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = hook_id(c)?;
    let now = number(c, "now")?;
    let seq = number(c, "seq")?;
    let attempt = number(c, "attempt")?;
    let ok = c["ok"].as_bool().ok_or_else(|| bad("Missing ok"))?;
    let Some(row) = db
        .query(
            "SELECT o.event,o.attempts,h.repo FROM hook_outbox o JOIN hooks h ON h.id=o.hook_id WHERE o.seq=? AND o.hook_id=? AND o.lease_until IS NOT NULL",
            &[json!(seq), json!(id)],
        )?
        .into_iter()
        .next()
        .filter(|r| r["attempts"].as_i64() == Some(attempt))
    else {
        return Ok(json!({ "stale": true }));
    };
    let error: Option<String> = c["error"].as_str().map(|e| e.chars().take(200).collect());
    db.query(
        "INSERT INTO hook_attempts(hook_id,delivery_id,event,attempt,ok,status,ms,error,at) VALUES(?,?,?,?,?,?,?,?,?)",
        &[json!(id), json!(format!("{}.{id}.{seq}", row["repo"].as_str().unwrap_or_default())),
          row["event"].clone(), json!(attempt), json!(i64::from(ok)), json!(c["status"].as_i64()),
          json!(c["ms"].as_i64().unwrap_or(0).max(0)), json!(error), json!(now)],
    )?;
    db.query(
        "DELETE FROM hook_attempts WHERE hook_id=?1 AND id NOT IN (SELECT id FROM hook_attempts WHERE hook_id=?1 ORDER BY id DESC LIMIT ?2)",
        &[json!(id), json!(LOG_SIZE)],
    )?;
    if ok {
        db.query("DELETE FROM hook_outbox WHERE seq=?", &[json!(seq)])?;
        db.query("UPDATE hooks SET failures=0 WHERE id=?", &[json!(id)])?;
        let more = !db
            .query(
                "SELECT seq FROM hook_outbox WHERE hook_id=? LIMIT 1",
                &[json!(id)],
            )?
            .is_empty();
        return Ok(json!({ "delivered": true, "more": more }));
    }
    let backoff = FIRST_BACKOFF_MS
        .saturating_mul(1 << (attempt - 1).clamp(0, 16))
        .min(MAX_BACKOFF_MS);
    db.query(
        "UPDATE hook_outbox SET lease_until=NULL,next_at=? WHERE seq=?",
        &[json!(now + backoff), json!(seq)],
    )?;
    db.query(
        "UPDATE hooks SET failures=failures+1 WHERE id=?",
        &[json!(id)],
    )?;
    db.query(
        "UPDATE hooks SET active=0,disabled_at=? WHERE id=? AND failures>=? AND active=1",
        &[json!(now), json!(id), json!(MAX_FAILURES)],
    )?;
    let active = db.query("SELECT active FROM hooks WHERE id=?", &[json!(id)])?[0]["active"] == 1;
    Ok(json!({ "delivered": false, "active": active, "retry_after_ms": backoff }))
}
