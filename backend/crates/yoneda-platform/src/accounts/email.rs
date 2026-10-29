//! The contact email's verification. A token is single-use, lives 24 hours and is stored
//! only as its digest (`email_token:<digest>`, with the address it was issued for). Verifying
//! one sets the account's `email_verified_at` and drops every token; changing the address
//! clears the verification and the tokens. Resends and changes share a limit (each sends an
//! email to an address the caller chose); the sign-up's welcome token does not count.
use super::op::EmailOp;
use super::*;

const TOKEN_LIFETIME: i64 = 24 * 60 * 60 * 1000;
const LIMIT_WINDOW: i64 = 24 * 60 * 60 * 1000;
const LIMIT: i64 = 5;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: EmailOp, now: i64) -> Result<Value> {
    match op {
        EmailOp::Status => {
            let a = account(db)?;
            let mut out = json!({"email": a["email"], "verified": verified(&a)});
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
            let Some(email) = a["email"].as_str() else {
                return Ok(json!({"issued":false,"reason":"no_email"}));
            };
            if verified(&a) {
                return Ok(json!({"issued":false,"reason":"verified"}));
            }
            if resend && !allow(db, now)? {
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
            if a["email"] == email {
                return Ok(json!({"changed":false,"reason":"same"}));
            }
            if !allow(db, now)? {
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
            a["email_verified_at"] = json!(now);
            put(db, "account", &a)?;
            drop_tokens(db)?;
            audit(db, "account.email_verified", now, json!({}))?;
            Ok(json!({"verified":true}))
        }
    }
}

fn verified(a: &Value) -> bool {
    a["email"].is_string() && a["email_verified_at"].is_i64()
}
fn token_hash(c: &Value) -> Result<String> {
    hash(c, "token_hash", &[64])
}
/// Whether the token exists, has not expired and was issued for the current address.
fn live<S: SqlStore>(db: &S, a: &Value, hash: &str, now: i64) -> bool {
    get(db, &format!("email_token:{hash}")).is_ok_and(|t| {
        t["expires"].as_i64().is_some_and(|at| at > now)
            && a["email"].is_string()
            && t["email"] == a["email"]
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
/// Counts one resend or change against the window; false once the limit is reached.
fn allow<S: SqlStore>(db: &S, now: i64) -> Result<bool> {
    let mut rate = get(db, "email_rate").unwrap_or(json!({"start":now,"count":0}));
    if rate["start"].as_i64().unwrap_or_default() + LIMIT_WINDOW <= now {
        rate = json!({"start":now,"count":0});
    }
    let n = rate["count"].as_i64().unwrap_or_default();
    if n >= LIMIT {
        return Ok(false);
    }
    rate["count"] = json!(n + 1);
    put(db, "email_rate", &rate)?;
    Ok(true)
}
