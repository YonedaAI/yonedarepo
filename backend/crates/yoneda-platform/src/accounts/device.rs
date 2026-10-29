//! Device login codes (RFC 8628 shape). Each user code has its own authority instance
//! (`device:<code>`), holding the digest of the device secret, never a token: the Worker
//! mints the personal token when the approved code is first redeemed, so a code is single
//! use and no secret waits in storage. Poll outcomes are answers, not errors, so the poll
//! bookkeeping (interval, consumption) commits with them.
use super::op::DeviceOp;
use super::*;
use subtle::ConstantTimeEq;

const LIFETIME_MS: i64 = 10 * 60 * 1000;
const INTERVAL_MS: i64 = 5_000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: DeviceOp, now: i64) -> Result<Value> {
    let code = user_code(c)?;
    let row = db
        .query(
            "SELECT * FROM device_codes WHERE user_code=?",
            &[json!(code)],
        )?
        .into_iter()
        .next();
    let live = row.as_ref().filter(|r| expires(r) > now);
    match op {
        DeviceOp::Create => {
            if live.is_some() {
                return Err(Error::new("ALREADY_EXISTS", "User code in use"));
            }
            let client = string(c, "client_name")?;
            if client.trim().is_empty()
                || client.chars().count() > 64
                || client.chars().any(char::is_control)
            {
                return Err(bad("client_name must be 1-64 printable characters"));
            }
            // The machine the CLI runs on, labelling the token it receives.
            let host = label(c, "host")?;
            db.query("DELETE FROM device_codes WHERE user_code=?", &[json!(code)])?;
            db.query(
                "INSERT INTO device_codes(user_code,secret_hash,client_name,host,created_at,expires_at,interval_ms,status) VALUES(?,?,?,?,?,?,?,'pending')",
                &[json!(code), json!(hash(c, "secret_hash", &[64])?), json!(client), json!(host), json!(now), json!(now + LIFETIME_MS), json!(INTERVAL_MS)],
            )?;
            Ok(json!({"user_code":code,"expires_at":now+LIFETIME_MS,"interval":INTERVAL_MS/1000}))
        }
        DeviceOp::Approve => {
            let Some(row) = row else {
                return Err(Error::new("NOT_FOUND", "Unknown or used code"));
            };
            if expires(&row) <= now {
                return Err(Error::new("EXPIRED_TOKEN", "This code has expired"));
            }
            if row["status"] != "pending" {
                return Err(Error::new("NOT_FOUND", "Unknown or used code"));
            }
            let account = string(c, "account")?;
            let deny = c["deny"] == true;
            let grant = if deny {
                Value::Null
            } else {
                super::tokens::grant(c)?
            };
            db.query(
                "UPDATE device_codes SET status=?,account=?,grant_json=? WHERE user_code=?",
                &[
                    json!(if deny { "denied" } else { "approved" }),
                    json!(account),
                    json!((!deny).then(|| grant.to_string())),
                    json!(code),
                ],
            )?;
            Ok(json!({"approved":!deny,"client_name":row["client_name"]}))
        }
        DeviceOp::Poll => poll(db, &code, live, c, now),
    }
}

fn poll<S: SqlStore>(
    db: &S,
    code: &str,
    live: Option<&Value>,
    c: &Value,
    now: i64,
) -> Result<Value> {
    let supplied = hash(c, "secret_hash", &[64])?;
    let expired = json!({"status":"EXPIRED_TOKEN"});
    let Some(row) = live else {
        return Ok(expired);
    };
    let stored = row["secret_hash"].as_str().unwrap_or_default();
    if !bool::from(supplied.as_bytes().ct_eq(stored.as_bytes())) || row["status"] == "consumed" {
        return Ok(expired);
    }
    let interval = row["interval_ms"].as_i64().unwrap_or(INTERVAL_MS);
    let too_soon = row["last_poll_at"]
        .as_i64()
        .is_some_and(|at| at + interval > now);
    let status = row["status"].as_str().unwrap_or_default();
    if status == "pending" {
        let next = if too_soon {
            interval + INTERVAL_MS
        } else {
            interval
        };
        db.query(
            "UPDATE device_codes SET last_poll_at=?,interval_ms=? WHERE user_code=?",
            &[json!(now), json!(next), json!(code)],
        )?;
        return Ok(if too_soon {
            json!({"status":"SLOW_DOWN","interval":next/1000})
        } else {
            json!({"status":"AUTHORIZATION_PENDING","interval":next/1000})
        });
    }
    // Approved or denied: answered once, then the code is spent.
    db.query(
        "UPDATE device_codes SET status='consumed',last_poll_at=? WHERE user_code=?",
        &[json!(now), json!(code)],
    )?;
    if status == "denied" {
        return Ok(json!({"status":"ACCESS_DENIED"}));
    }
    let grant: Value = serde_json::from_str(row["grant_json"].as_str().unwrap_or("null"))
        .map_err(|_| bad("Corrupt device grant"))?;
    Ok(
        json!({"status":"APPROVED","account":row["account"],"grant":grant,"client_name":row["client_name"],"host":row["host"]}),
    )
}

fn expires(row: &Value) -> i64 {
    row["expires_at"].as_i64().unwrap_or_default()
}

/// Eight characters of the RFC 8628 consonant alphabet, stored without the dash.
fn user_code(c: &Value) -> Result<String> {
    let code = string(c, "user_code")?;
    if code.len() == 8 && code.bytes().all(|b| b"BCDFGHJKLMNPQRSTVWXZ".contains(&b)) {
        Ok(code)
    } else {
        Err(bad("Invalid user code"))
    }
}
