//! Durable membership delivery, committed beside the grant. Trusted adapters move it.
use super::*;
use crate::storage::number;
const LEASE_MS: i64 = 60_000;
const SAFE_RETRY_MS: i64 = 23 * 60 * 60 * 1000;

pub(super) fn added<S: SqlStore>(
    db: &S,
    org: &str,
    recipient: &str,
    role: &str,
    now: i64,
    incarnation: i64,
) -> Result<()> {
    db.query(
        "INSERT INTO org_member_notices(recipient,org,role,created_at,recipient_incarnation) VALUES(?,?,?,?,?)",
        &[json!(recipient), json!(org), json!(role), json!(now),json!(incarnation)],
    )?;
    Ok(())
}
pub(super) fn cancel<S: SqlStore>(db: &S, recipient: Option<&str>) -> Result<()> {
    if let Some(recipient) = recipient {
        db.query(
            "UPDATE org_member_notices SET canceled=1 WHERE recipient=? AND completed=0",
            &[json!(recipient)],
        )?;
    } else {
        db.query(
            "UPDATE org_member_notices SET canceled=1 WHERE completed=0",
            &[],
        )?;
    }
    Ok(())
}
pub(super) fn pending<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    let rows=db.query("SELECT id,org,recipient FROM org_member_notices WHERE completed=0 AND canceled=0 ORDER BY enqueued_at,id LIMIT 20",&[])?;
    for row in &rows {
        db.query(
            "UPDATE org_member_notices SET enqueued_at=? WHERE id=?",
            &[json!(now), row["id"].clone()],
        )?;
    }
    Ok(json!({"notices":rows}))
}
fn row<S: SqlStore>(db: &S, c: &Value) -> Result<Option<Value>> {
    Ok(db
        .query(
            "SELECT * FROM org_member_notices WHERE id=? AND completed=0 AND canceled=0",
            &[json!(number(c, "id")?)],
        )?
        .into_iter()
        .next())
}
fn leased(row: &Value, c: &Value, now: i64) -> Result<()> {
    if row["epoch"] != c["epoch"] || row["lease_until"].as_i64().is_none_or(|until| until <= now) {
        return Err(Error::new("STALE_LEASE", "Delivery lease expired"));
    }
    Ok(())
}
pub(super) fn claim<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let Some(mut row) = row(db, c)? else {
        return Ok(json!({"notice":null}));
    };
    if row["lease_until"].as_i64().is_some_and(|until| until > now) {
        return Ok(json!({"notice":null,"busy":true}));
    }
    let epoch = row["epoch"].as_i64().unwrap_or_default() + 1;
    db.query(
        "UPDATE org_member_notices SET epoch=?,lease_until=? WHERE id=?",
        &[json!(epoch), json!(now + LEASE_MS), row["id"].clone()],
    )?;
    row["epoch"] = json!(epoch);
    row["lease_until"] = json!(now + LEASE_MS);
    Ok(json!({"notice":row}))
}
pub(super) fn mail_begin<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let Some(row) = row(db, c)? else {
        return Ok(json!({"allowed":false}));
    };
    leased(&row, c, now)?;
    let first = row["first_attempt"].as_i64().unwrap_or(now);
    if now - first >= SAFE_RETRY_MS {
        return Ok(json!({"allowed":false}));
    }
    db.query(
        "UPDATE org_member_notices SET first_attempt=COALESCE(first_attempt,?) WHERE id=?",
        &[json!(now), row["id"].clone()],
    )?;
    Ok(json!({"allowed":true}))
}
pub(super) fn finish<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let Some(row) = row(db, c)? else {
        return Ok(json!({"completed":false}));
    };
    leased(&row, c, now)?;
    let state = string(c, "email_state")?;
    if !matches!(state.as_str(), "sent" | "skipped" | "uncertain" | "failed") {
        return Err(bad("Invalid email delivery state"));
    }
    db.query(
        "UPDATE org_member_notices SET completed=1,email_state=?,lease_until=0 WHERE id=?",
        &[json!(state), row["id"].clone()],
    )?;
    Ok(json!({"completed":true}))
}
