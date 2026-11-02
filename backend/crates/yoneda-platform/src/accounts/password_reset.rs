//! A forgotten password's emailed link, and a new recovery code for a signed-in person. A
//! reset token is single-use, lives an hour and is stored only as its digest
//! (`reset_token:<digest>`, with the confirmed address it was issued for). An account holds at
//! most one: a new request replaces the last, and an address change, a recovery or a reset
//! drops it. Requests count against their own daily limit, apart from confirmation emails.
//! A reset ends the browser sessions, revokes every token (CLI sign-ins and agents are tokens)
//! with the SSH keys those added, and replaces the password and the recovery code: whoever
//! took the account should lose it. SSH keys added by a signed-in person and linked sign-ins
//! stay; only a recovery clears those. Nothing here says why a request was refused: the
//! adapter gives every asker the same answer.
use super::op::PasswordOp;
use super::*;

const LIFETIME: i64 = 60 * 60 * 1000;
const RATE: &str = "reset_rate";

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: PasswordOp, now: i64) -> Result<Value> {
    match op {
        PasswordOp::ResetRequest => request(db, c, now),
        PasswordOp::ResetStatus => {
            let email = account(db).ok().filter(|_| allowed(db, now));
            let email = email.and_then(|a| live(db, &a, &token_hash(c).ok()?, now));
            Ok(json!({ "email": email }))
        }
        PasswordOp::Reset => reset(db, c, now),
        PasswordOp::RecoveryRegenerate => regenerate(db, c, now),
    }
}

/// `password_reset_request {token_hash}`: a link for a confirmed address, unless limited.
fn request<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let hash = token_hash(c)?;
    let refused = Ok(json!({ "issued": false }));
    let Ok(a) = account(db) else { return refused };
    let Some(email) = super::email::confirmed(&a) else {
        return refused;
    };
    if !allowed(db, now) || !super::email::allow(db, RATE, now)? {
        return refused;
    }
    drop_tokens(db)?;
    put(
        db,
        &record(&hash),
        &json!({"email":email,"expires":now + LIFETIME}),
    )?;
    Ok(json!({ "issued": true }))
}

/// `password_reset {token_hash, password, salt, new_recovery_hash}`: the token is checked
/// first, so a guess costs no password hash. A refused password fails the transaction and
/// leaves the link usable.
fn reset<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let refused = Ok(json!({ "authenticated": false }));
    let Ok(mut a) = account(db) else {
        return refused;
    };
    if live(db, &a, &token_hash(c)?, now).is_none() {
        return refused;
    }
    if super::access::suspended_at(db)?.is_some() {
        return Ok(json!({"authenticated":false,"suspended":true}));
    }
    if !super::access::valid(db, now)? {
        return refused;
    }
    a["verifier"] = super::signin::verifier(c)?;
    a["recovery_hash"] = json!(hash(c, "new_recovery_hash", &[64])?);
    put(db, "account", &a)?;
    super::signin::end_sessions(db)?;
    drop_tokens(db)?;
    let (tokens, ssh_keys) = super::tokens::revoke_all_with_keys(db, now)?;
    let orgs = super::orgs::hints(db)?;
    audit(
        db,
        "account.password_reset",
        now,
        json!({"tokens":tokens,"ssh_keys":ssh_keys,"orgs":orgs}),
    )?;
    Ok(public_account(&a))
}

/// `recovery_regenerate {session_hash, recovery_hash}`: only a live browser session, on an
/// account with a password for the code to reset.
fn regenerate<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let refused = Ok(json!({ "regenerated": false }));
    let Ok(mut a) = account(db) else {
        return refused;
    };
    let session = format!("session:{}", hash(c, "session_hash", &[64])?);
    let signed_in =
        get(db, &session).is_ok_and(|s| s["expires"].as_i64().is_some_and(|at| at > now));
    if !signed_in || !allowed(db, now) || !a["verifier"].is_object() {
        return refused;
    }
    a["recovery_hash"] = json!(hash(c, "recovery_hash", &[64])?);
    put(db, "account", &a)?;
    let orgs = super::orgs::hints(db)?;
    audit(
        db,
        "account.recovery_regenerated",
        now,
        json!({ "orgs": orgs }),
    )?;
    Ok(json!({ "regenerated": true }))
}

/// Drops the account's reset token, if any.
pub(super) fn drop_tokens<S: SqlStore>(db: &S) -> Result<()> {
    db.query(
        &format!("DELETE FROM {TABLE} WHERE id LIKE 'reset_token:%'"),
        &[],
    )?;
    Ok(())
}

fn record(hash: &str) -> String {
    format!("reset_token:{hash}")
}
fn token_hash(c: &Value) -> Result<String> {
    hash(c, "token_hash", &[64])
}
/// Whether the account may sign in at all (not suspended, no lapsed reviewer policy).
fn allowed<S: SqlStore>(db: &S, now: i64) -> bool {
    super::access::valid(db, now).unwrap_or(false)
}
/// The address a live token was issued for, while it is still the confirmed one.
fn live<S: SqlStore>(db: &S, a: &Value, hash: &str, now: i64) -> Option<String> {
    let token = get(db, &record(hash)).ok()?;
    let email = super::email::confirmed(a)?;
    (token["expires"].as_i64().is_some_and(|at| at > now) && token["email"] == email)
        .then(|| email.to_string())
}
