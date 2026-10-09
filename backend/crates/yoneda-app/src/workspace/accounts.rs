use super::*;
use crate::storage::{create, hash};
use argon2::{Algorithm, Argon2, Params, Version};
use subtle::ConstantTimeEq;
const LIFETIME: i64 = 7 * 24 * 60 * 60 * 1000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    match string(c, "op")?.as_str() {
        "signup" => {
            let username = string(c, "username")?;
            if !(3..=32).contains(&username.len())
                || !username
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_lowercase)
                || !username
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            {
                return Err(bad(
                    "Username must be 3–32 lowercase letters, digits or underscores, starting with a letter",
                ));
            }
            if get(db, TABLE, "account").is_ok() {
                return Err(Error::new("ALREADY_EXISTS", "Username unavailable"));
            }
            let verifier = verifier(c)?;
            let a = json!({"username":username,"verifier":verifier,"recovery_hash":hash(c,"recovery_hash",&[64])?,"created_at":now});
            create(db, TABLE, "account", &a)?;
            session(db, c, now)?;
            audit(db, "account.created", now, json!({"username":username}))?;
            Ok(public_account(&a))
        }
        "session" => {
            let key = format!("session:{}", hash(c, "session_hash", &[64])?);
            let valid = get(db, TABLE, &key)
                .is_ok_and(|s| s["expires"].as_i64().is_some_and(|at| at > now));
            if valid {
                Ok(public_account(&account(db)?))
            } else {
                Ok(json!({"authenticated":false}))
            }
        }
        "logout" => {
            db.query(
                "DELETE FROM workspace_records WHERE id=?",
                &[json!(format!(
                    "session:{}",
                    hash(c, "session_hash", &[64])?
                ))],
            )?;
            Ok(json!({"authenticated":false}))
        }
        "login" | "recover" => {
            let Ok(mut a) = account(db) else {
                return Ok(json!({"authenticated":false}));
            };
            if !allow_attempt(db, now)? {
                return Ok(json!({"authenticated":false,"limited":true}));
            }
            let recovery = c["op"] == "recover";
            let valid = if recovery {
                equal(
                    &hash(c, "recovery_hash", &[64])?,
                    a["recovery_hash"].as_str().unwrap_or_default(),
                )
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
                audit(db, "account.recovered", now, json!({}))?;
            } else {
                session(db, c, now)?;
            }
            Ok(public_account(&a))
        }
        _ => Err(bad("Unknown account operation")),
    }
}
fn session<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<()> {
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
    let mut rate = get(db, TABLE, "login_rate").unwrap_or(json!({"start":now,"count":0}));
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
        .chunks_exact(2)
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
