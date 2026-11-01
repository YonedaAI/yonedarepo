//! The contact email's verification. A token is single-use, lives 24 hours and is stored
//! only as its digest (`email_token:<digest>`, with the address it was issued for). Verifying
//! one sets the account's `email_verified_at` and drops every token; changing the address
//! clears the verification and the tokens. Resends and changes share a limit (each sends an
//! email to an address the caller chose); the sign-up's welcome token does not count. Contact
//! support has its own limit: a request takes a slot before its email is sent and gives it
//! back when the email could not be. An account named by an address has that address as its
//! contact email until it stores another (`contact`); a name proves nothing about an inbox,
//! so it reads unconfirmed until a link is used.
use super::op::EmailOp;
use super::*;

const TOKEN_LIFETIME: i64 = 24 * 60 * 60 * 1000;
const LIMIT_WINDOW: i64 = 24 * 60 * 60 * 1000;
const LIMIT: i64 = 5;
const EMAIL_RATE: &str = "email_rate";
const SUPPORT_RATE: &str = "support_rate";

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: EmailOp, now: i64) -> Result<Value> {
    match op {
        EmailOp::Status => {
            let a = account(db)?;
            let mut out = json!({"email": contact(&a), "verified": verified(&a)});
            if !c["token_hash"].is_null() {
                out["token_valid"] = json!(live(db, &a, &token_hash(c)?, now));
            }
            Ok(out)
        }
        EmailOp::Token => {
            let resend = match string(c, "purpose")?.as_str() {
                "welcome" => false,
                "resend" => true,
                _ => return Err(bad("purpose must be welcome or resend")),
            };
            let a = account(db)?;
            let Some(email) = contact(&a) else {
                return Ok(json!({"issued":false,"reason":"no_email"}));
            };
            if verified(&a) {
                return Ok(json!({"issued":false,"reason":"verified"}));
            }
            if resend && !allow(db, EMAIL_RATE, now)? {
                return Ok(json!({"issued":false,"reason":"limited"}));
            }
            issue(db, &token_hash(c)?, email, now)?;
            Ok(json!({"issued":true}))
        }
        EmailOp::Change => {
            let mut a = account(db)?;
            let email = super::signin::contact_email(c)?
                .ok_or_else(|| bad("Enter a valid email address"))?;
            let hash = token_hash(c)?;
            if contact(&a) == Some(email.as_str()) {
                return Ok(json!({"changed":false,"reason":"same"}));
            }
            if !allow(db, EMAIL_RATE, now)? {
                return Ok(json!({"changed":false,"reason":"limited"}));
            }
            a["email"] = json!(email);
            if let Some(fields) = a.as_object_mut() {
                fields.remove("email_verified_at");
            }
            put(db, "account", &a)?;
            drop_tokens(db)?;
            issue(db, &hash, &email, now)?;
            audit(db, "account.email_changed", now, json!({}))?;
            Ok(json!({"changed":true}))
        }
        EmailOp::Verify => {
            let mut a = account(db)?;
            if !live(db, &a, &token_hash(c)?, now) {
                return Ok(json!({"verified":false}));
            }
            a["email"] = json!(contact(&a));
            a["email_verified_at"] = json!(now);
            put(db, "account", &a)?;
            drop_tokens(db)?;
            audit(db, "account.email_verified", now, json!({}))?;
            Ok(json!({"verified":true}))
        }
        EmailOp::SupportAdmit => Ok(json!({"admitted": allow(db, SUPPORT_RATE, now)?})),
        EmailOp::SupportRelease => {
            release(db, SUPPORT_RATE, now)?;
            Ok(json!({}))
        }
    }
}

/// The account's contact email: the stored one, or the address the account is named by.
pub(super) fn contact(a: &Value) -> Option<&str> {
    a["email"]
        .as_str()
        .or_else(|| a["username"].as_str().filter(|name| name.contains('@')))
}
fn verified(a: &Value) -> bool {
    contact(a).is_some() && a["email_verified_at"].is_i64()
}
fn token_hash(c: &Value) -> Result<String> {
    hash(c, "token_hash", &[64])
}
/// Whether the token exists, has not expired and was issued for the current address.
fn live<S: SqlStore>(db: &S, a: &Value, hash: &str, now: i64) -> bool {
    get(db, &format!("email_token:{hash}")).is_ok_and(|t| {
        t["expires"].as_i64().is_some_and(|at| at > now)
            && contact(a).is_some_and(|email| t["email"] == email)
    })
}
fn issue<S: SqlStore>(db: &S, hash: &str, email: &str, now: i64) -> Result<()> {
    db.query(
        "DELETE FROM workspace_records WHERE id LIKE 'email_token:%' AND json_extract(payload,'$.expires')<=?",
        &[json!(now)],
    )?;
    put(
        db,
        &format!("email_token:{hash}"),
        &json!({"email":email,"expires":now + TOKEN_LIFETIME}),
    )
}
fn drop_tokens<S: SqlStore>(db: &S) -> Result<()> {
    db.query(
        "DELETE FROM workspace_records WHERE id LIKE 'email_token:%'",
        &[],
    )?;
    Ok(())
}
/// Counts one request against `record`'s window; false once the limit is reached.
fn allow<S: SqlStore>(db: &S, record: &str, now: i64) -> Result<bool> {
    let mut rate = get(db, record).unwrap_or(json!({"start":now,"count":0}));
    if rate["start"].as_i64().unwrap_or_default() + LIMIT_WINDOW <= now {
        rate = json!({"start":now,"count":0});
    }
    let n = rate["count"].as_i64().unwrap_or_default();
    if n >= LIMIT {
        return Ok(false);
    }
    rate["count"] = json!(n + 1);
    put(db, record, &rate)?;
    Ok(true)
}
/// Takes one request back off `record`'s window, if it is still the current one.
fn release<S: SqlStore>(db: &S, record: &str, now: i64) -> Result<()> {
    let Ok(mut rate) = get(db, record) else {
        return Ok(());
    };
    let n = rate["count"].as_i64().unwrap_or_default();
    if n > 0 && rate["start"].as_i64().unwrap_or_default() + LIMIT_WINDOW > now {
        rate["count"] = json!(n - 1);
        put(db, record, &rate)?;
    }
    Ok(())
}
