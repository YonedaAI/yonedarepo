//! Deleting an account. The adapter runs the steps (`platform-account-close.ts`), each repeatable,
//! and this authority holds them together: `account_closure_plan` names what must be released
//! elsewhere, `account_credentials_end` ends every way in, and `account_close` comes last and
//! empties this instance, as its handle and name are free for someone else at once. Until that
//! last step the account can sign in again and finish, and nothing is left half done that a
//! second run would not find: what the plan names stays here until then. A legal hold refuses
//! the last step as it refuses the adapter's first.
use super::op::ClosureOp;
use super::*;

/// How long a session lasts, as `signin` sets it.
const SESSION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: ClosureOp, now: i64) -> Result<Value> {
    match op {
        ClosureOp::Plan => plan(db, c, now),
        ClosureOp::EndCredentials => {
            account(db)?;
            for table in ["account_tokens", "account_ssh_keys", "device_codes"] {
                db.query(&format!("DELETE FROM {table}"), &[])?;
            }
            super::signin::end_sessions(db)?;
            Ok(json!({ "ended": true }))
        }
        ClosureOp::Close => close(db, c),
    }
}

/// How long ago the session `session_hash` signed in.
fn session_age<S: SqlStore>(db: &S, c: &Value, now: i64) -> Option<i64> {
    let digest = c["session_hash"].as_str()?;
    let session = get(db, &format!("session:{digest}")).ok()?;
    Some(now - (session["expires"].as_i64()? - SESSION_MS))
}

fn plan<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let a = account(db)?;
    let installation = db.query("SELECT installation FROM account_github_installation", &[])?;
    Ok(json!({
        "username": a["username"],
        "handle": super::handles::own(db)?,
        "email": super::email::contact(&a),
        "identities": db.query("SELECT provider,subject,email FROM account_identities", &[])?,
        "ssh_keys": db.query(
            "SELECT id,fingerprint FROM account_ssh_keys WHERE removed_at IS NULL",
            &[],
        )?,
        "orgs": super::orgs::hints(db)?,
        "installation": installation.first().map(|row| row["installation"].clone()),
        "session_age_ms": session_age(db, c, now),
    }))
}

/// Every table of this instance empty, and so no account: repeating it finds none. An org is
/// never closed here.
fn close<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    if account(db).is_err() {
        return Ok(json!({ "closed": false }));
    }
    super::holds::refuse_account_close(db, c)?;
    let tables = db.query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' \
         AND name NOT LIKE '_cf_%' AND name<>'workspace_migrations'",
        &[],
    )?;
    for table in tables {
        let name = table["name"].as_str().unwrap_or_default();
        db.query(&format!("DELETE FROM \"{name}\""), &[])?;
    }
    Ok(json!({ "closed": true }))
}
