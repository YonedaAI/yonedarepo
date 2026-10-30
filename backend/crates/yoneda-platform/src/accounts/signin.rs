use super::op::SigninOp;
use super::*;
use argon2::{Algorithm, Argon2, Params, Version};
use subtle::ConstantTimeEq;
const LIFETIME: i64 = 7 * 24 * 60 * 60 * 1000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: SigninOp, now: i64) -> Result<Value> {
    match op {
        SigninOp::Signup => {
            let username =
                yoneda_core::account::normalize_account_identifier(&string(c, "username")?)?;
            super::handles::name_free(db, &username)?;
            let email = contact_email(c)?;
            let verifier = verifier(c)?;
            let mut a = json!({"username":username,"verifier":verifier,"recovery_hash":hash(c,"recovery_hash",&[64])?,"created_at":now});
            // Forward-only: accounts made before the field have none.
            if let Some(email) = email {
                a["email"] = json!(email);
            }
            put(db, "account", &a)?;
            session(db, c, now)?;
            audit(db, "account.created", now, json!({"username":username}))?;
            Ok(public_account(&a))
        }
        SigninOp::Session => {
            let key = format!("session:{}", hash(c, "session_hash", &[64])?);
            let valid = super::access::valid(db, now)?
                && get(db, &key).is_ok_and(|s| s["expires"].as_i64().is_some_and(|at| at > now));
            if valid {
                let mut public = public_account(&account(db)?);
                public["orgs"] = json!(super::orgs::hints(db)?);
                Ok(public)
            } else {
                Ok(json!({"authenticated":false}))
            }
        }
        // Whether this account was signed up (the platform invites members by account).
        SigninOp::AccountExists => Ok(json!({"exists": account(db).is_ok()})),
        // The welcome email's sent marker and the contact email it goes to (none on an
        // account made without one); the send itself happens outside, from a queue job.
        SigninOp::WelcomeState => Ok(json!({
            "sent": get(db, "welcome_email").is_ok(),
            "email": account(db).map(|a| a["email"].clone()).unwrap_or(Value::Null),
        })),
        SigninOp::WelcomeSent => {
            account(db)?;
            if get(db, "welcome_email").is_err() {
                put(db, "welcome_email", &json!({"at":now}))?;
                audit(db, "account.welcome_sent", now, json!({}))?;
            }
            Ok(json!({"sent":true}))
        }
        SigninOp::Logout => {
            db.query(
                "DELETE FROM workspace_records WHERE id=?",
                &[json!(format!(
                    "session:{}",
                    hash(c, "session_hash", &[64])?
                ))],
            )?;
            Ok(json!({"authenticated":false}))
        }
        SigninOp::Login | SigninOp::Recover => {
            let Ok(mut a) = account(db) else {
                return Ok(json!({"authenticated":false}));
            };
            if !super::access::valid(db, now)? || !allow_attempt(db, now)? {
                return Ok(json!({"authenticated":false,"limited":true}));
            }
            let recovery = op == SigninOp::Recover;
            // An account made by a sign-in provider has no password (nor a recovery code).
            let valid = if recovery {
                equal(
                    &hash(c, "recovery_hash", &[64])?,
                    a["recovery_hash"].as_str().unwrap_or_default(),
                )
            } else if !a["verifier"].is_object() {
                false
            } else {
                let supplied =
                    password_hash(&string(c, "password")?, &string(&a["verifier"], "salt")?)?;
                equal(
                    &supplied,
                    a["verifier"]["hash"].as_str().unwrap_or_default(),
                )
            };
            if !valid {
                return Ok(json!({"authenticated":false}));
            }
            if recovery {
                a["verifier"] = verifier(c)?;
                a["recovery_hash"] = json!(hash(c, "new_recovery_hash", &[64])?);
                put(db, "account", &a)?;
                db.query(
                    "DELETE FROM workspace_records WHERE id LIKE 'session:%' OR id LIKE 'grant:%'",
                    &[],
                )?;
                super::tokens::revoke_all(db, now)?;
                super::ssh_keys::remove_all(db, now)?;
                super::identities::remove_all(db)?;
                audit(db, "account.recovered", now, json!({}))?;
            } else {
                session(db, c, now)?;
            }
            Ok(public_account(&a))
        }
    }
}
/// The sign-up's contact email (the welcome email's address), if given: normalized, and
/// refused unless it is an email address. Stored only; never part of the public account.
pub(super) fn contact_email(c: &Value) -> Result<Option<String>> {
    match &c["email"] {
        Value::Null => Ok(None),
        Value::String(text) => yoneda_core::account::normalize_account_identifier(text)
            .ok()
            .filter(|email| email.contains('@'))
            .map(Some)
            .ok_or_else(|| bad("Enter a valid email address")),
        _ => Err(bad("Enter a valid email address")),
    }
}
pub(super) fn session<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<()> {
    db.query("DELETE FROM workspace_records WHERE id LIKE 'session:%' AND json_extract(payload,'$.expires')<=?", &[json!(now)])?;
    let count = db.query(
        "SELECT COUNT(*) AS n FROM workspace_records WHERE id LIKE 'session:%'",
        &[],
    )?;
    if count[0]["n"].as_i64().unwrap_or_default() >= 10 {
        db.query("DELETE FROM workspace_records WHERE id=(SELECT id FROM workspace_records WHERE id LIKE 'session:%' ORDER BY json_extract(payload,'$.expires'),id LIMIT 1)", &[])?;
    }
    put(
        db,
        &format!("session:{}", hash(c, "session_hash", &[64])?),
        &json!({"expires":now+LIFETIME}),
    )
}
fn allow_attempt<S: SqlStore>(db: &S, now: i64) -> Result<bool> {
    let mut rate = get(db, "login_rate").unwrap_or(json!({"start":now,"count":0}));
    if rate["start"].as_i64().unwrap_or_default() + 60_000 <= now {
        rate = json!({"start":now,"count":0});
    }
    let n = rate["count"].as_i64().unwrap_or_default();
    rate["count"] = json!(n.saturating_add(1));
    put(db, "login_rate", &rate)?;
    Ok(n < 10)
}
fn verifier(c: &Value) -> Result<Value> {
    let password = string(c, "password")?;
    if !(12..=128).contains(&password.len()) {
        return Err(bad("Use a password of 12–128 bytes"));
    }
    let salt = hash(c, "salt", &[32])?;
    Ok(
        json!({"algorithm":"argon2id-v19-m19456-t2-p1","salt":salt,"hash":password_hash(&password,&salt)?}),
    )
}
fn password_hash(password: &str, salt: &str) -> Result<String> {
    if password.len() > 128 || salt.len() != 32 {
        return Err(bad("Invalid password or salt"));
    }
    let bytes: Vec<u8> = salt
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|v| {
            std::str::from_utf8(v)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
                .ok_or_else(|| bad("Invalid salt"))
        })
        .collect::<Result<_>>()?;
    let params = Params::new(19456, 2, 1, Some(32)).map_err(|e| bad(&e.to_string()))?;
    let mut output = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &bytes, &mut output)
        .map_err(|e| bad(&e.to_string()))?;
    Ok(output.iter().map(|b| format!("{b:02x}")).collect())
}
fn equal(a: &str, b: &str) -> bool {
    bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}
