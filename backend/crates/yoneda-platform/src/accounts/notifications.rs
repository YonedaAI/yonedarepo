//! Personal inbox entries name only the organization and role, never an email address.
use super::op::NotificationOp;
use super::*;
use crate::storage::number;
pub(super) fn handle<S: SqlStore>(
    db: &S,
    c: &Value,
    op: NotificationOp,
    now: i64,
) -> Result<Value> {
    use NotificationOp as N;
    // The adapter carries the cookie digest; validate again inside this same transaction.
    // A held old request must not reach a new person who later takes this account name.
    let cookie_bound = matches!(op, N::Dismiss | N::Clear)
        || (matches!(op, N::List | N::Read) && !c["session_hash"].is_null());
    if cookie_bound
        && (c["session_hash"].is_null()
            || super::signin::handle(db, c, super::op::SigninOp::Session, now)?["authenticated"]
                != true)
    {
        return Err(Error::new("UNAUTHORIZED", "Sign in to see notifications"));
    }
    match op {
        N::Pending => super::member_notices::pending(db, now),
        N::Claim => super::member_notices::claim(db, c, now),
        N::MailBegin => super::member_notices::mail_begin(db, c, now),
        N::Finish => super::member_notices::finish(db, c, now),
        N::Identity => Ok(json!({"incarnation":incarnation(db)?})),
        N::Hint => hint(db, c, now),
        N::Put => put_notice(db, c, now),
        N::List => list(db),
        N::Read => read(db, c, now),
        N::Dismiss => dismiss(db, c, now),
        N::Clear => clear(db, now),
    }
}
// Account close deletes this row but SQLite's AUTOINCREMENT sequence survives.
// Allocation and recipient insertion share the account transaction; clocks do not identify users.
fn incarnation<S: SqlStore>(db: &S) -> Result<i64> {
    account(db)?;
    let mut rows = db.query("SELECT id FROM account_incarnation", &[])?;
    if rows.is_empty() {
        rows = db.query(
            "INSERT INTO account_incarnation DEFAULT VALUES RETURNING id",
            &[],
        )?;
    }
    rows.first()
        .and_then(|r| r["id"].as_i64())
        .ok_or_else(|| bad("Missing account identity"))
}
fn matches<S: SqlStore>(db: &S, c: &Value) -> Result<bool> {
    if account(db).is_err() {
        return Ok(false);
    }
    let expected = number(c, "incarnation")?;
    let rows = db.query("SELECT id FROM account_incarnation", &[])?;
    Ok(expected > 0
        && rows
            .first()
            .is_some_and(|r| r["id"].as_i64() == Some(expected)))
}
fn hint<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if !matches(db, c)? {
        return Ok(json!({"recorded":false}));
    }
    let org = super::orgs::org_name(&string(c, "org")?)?;
    db.query(
        "INSERT INTO account_orgs(org,added_at) VALUES(?,?) ON CONFLICT(org) DO NOTHING",
        &[json!(org), json!(now)],
    )?;
    Ok(json!({"recorded":true}))
}
fn put_notice<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    if !matches(db, c)? {
        return Ok(json!({"recorded":false}));
    }
    let org = super::orgs::org_name(&string(c, "org")?)?;
    let seq = number(c, "id")?;
    if seq < 1 {
        return Err(bad("Invalid notification id"));
    }
    let role = string(c, "role")?;
    if !matches!(role.as_str(), "member" | "owner") {
        return Err(bad("Invalid organization role"));
    }
    let id = format!("{org}:{seq}");
    let at = number(c, "at")?;
    if super::notification_retention::accepts(db, at, &id)? {
        db.query("INSERT INTO account_notifications(id,org,role,at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",&[json!(id),json!(org),json!(role),json!(at)])?;
    }
    db.query(
        "INSERT INTO account_orgs(org,added_at) VALUES(?,?) ON CONFLICT(org) DO NOTHING",
        &[json!(org), json!(number(c, "at")?)],
    )?;
    super::notification_retention::prune(db)?;
    let contact = super::email::handle(db, &json!({}), super::op::EmailOp::Status, now)?;
    Ok(json!({"recorded":true,"contact":contact}))
}
fn list<S: SqlStore>(db: &S) -> Result<Value> {
    account(db)?;
    let items=db.query("SELECT id,org,role,at,read_at IS NULL AS unread FROM account_notifications WHERE dismissed_at IS NULL ORDER BY at DESC,id DESC LIMIT 50",&[])?;
    let unread = db.query(
        "SELECT COUNT(*) AS n FROM account_notifications WHERE read_at IS NULL AND dismissed_at IS NULL",
        &[],
    )?;
    Ok(json!({"items":items,"unread":unread[0]["n"]}))
}
fn read<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    let through = number(c, "through")?;
    db.query(
        "UPDATE account_notifications SET read_at=? WHERE read_at IS NULL AND at<=?",
        &[json!(now), json!(through)],
    )?;
    list(db)
}

fn dismiss<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    let id = string(c, "id")?;
    let valid = id.split_once(':').is_some_and(|(org, seq)| {
        super::orgs::org_name(org).is_ok()
            && seq
                .parse::<i64>()
                .is_ok_and(|n| n > 0 && n.to_string() == seq)
    });
    if id.len() > 64 || !valid {
        return Err(bad("Choose a valid notification"));
    }
    db.query(
        "UPDATE account_notifications SET dismissed_at=? WHERE id=? AND dismissed_at IS NULL",
        &[json!(now), json!(id)],
    )?;
    list(db)
}
fn clear<S: SqlStore>(db: &S, now: i64) -> Result<Value> {
    account(db)?;
    db.query(
        "UPDATE account_notifications SET dismissed_at=? WHERE dismissed_at IS NULL",
        &[json!(now)],
    )?;
    list(db)
}
