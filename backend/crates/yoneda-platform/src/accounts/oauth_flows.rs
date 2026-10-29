//! OAuth sign-in attempts and identity claims, each on its own authority instance (same
//! class and schema as an account). An attempt (`oauth:<state digest>`) holds its PKCE
//! verifier, nonce and browser binding for ten minutes and is consumed by its first
//! callback, whatever the outcome. A claim (`identity:<provider>:<subject>` or
//! `email:<sha256>`) names the one account holding that identity or verified email; like an
//! SSH fingerprint claim it grants nothing alone: the adapter re-checks it with the account.
use super::identities::provider;
use super::op::OAuthOp;
use super::*;
use subtle::ConstantTimeEq;

const LIFETIME_MS: i64 = 10 * 60 * 1000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: OAuthOp, now: i64) -> Result<Value> {
    match op {
        OAuthOp::FlowPut => put_flow(db, c, now),
        OAuthOp::FlowTake => take_flow(db, c, now),
        OAuthOp::Claim => {
            let (key, account) = (key(c)?, string(c, "account")?);
            if let Some(held) = claim(db, &key)?.filter(|h| h["account"] != account)
                && c["replace"] != true
            {
                return Ok(json!({"claimed":false,"holder":held}));
            }
            db.query(
                "INSERT INTO identity_claims(key,account,claimed_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET account=excluded.account,claimed_at=excluded.claimed_at",
                &[json!(key), json!(account), json!(now)],
            )?;
            Ok(json!({"claimed":true}))
        }
        OAuthOp::ClaimGet => {
            claim(db, &key(c)?)?.ok_or_else(|| Error::new("NOT_FOUND", "Unknown identity"))
        }
        OAuthOp::ClaimRelease => {
            db.query(
                "DELETE FROM identity_claims WHERE key=? AND account=?",
                &[json!(key(c)?), json!(string(c, "account")?)],
            )?;
            Ok(json!({"released":true}))
        }
    }
}

fn put_flow<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let state = hash(c, "state_hash", &[64])?;
    if !db
        .query(
            "SELECT 1 FROM oauth_flows WHERE state_hash=?",
            &[json!(state)],
        )?
        .is_empty()
    {
        return Err(Error::new("ALREADY_EXISTS", "Sign-in attempt in use"));
    }
    let intent = string(c, "intent")?;
    let (account, session) = match intent.as_str() {
        "signin" => (Value::Null, Value::Null),
        "link" => (
            json!(string(c, "account")?),
            json!(hash(c, "session_hash", &[64])?),
        ),
        _ => return Err(bad("Unknown sign-in intent")),
    };
    // RFC 7636: 43-128 unreserved characters.
    let verifier = string(c, "verifier")?;
    if !(43..=128).contains(&verifier.len())
        || !verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
    {
        return Err(bad("Invalid PKCE verifier"));
    }
    let return_to = string(c, "return_to")?;
    if !return_to.starts_with('/') || return_to.starts_with("//") || return_to.len() > 512 {
        return Err(bad("Invalid return path"));
    }
    db.query(
        "INSERT INTO oauth_flows(state_hash,provider,binding_hash,verifier,nonce,intent,account,session_hash,return_to,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        &[
            json!(state),
            json!(provider(c)?),
            json!(hash(c, "binding_hash", &[64])?),
            json!(verifier),
            json!(hash(c, "nonce", &[32])?),
            json!(intent),
            account,
            session,
            json!(return_to),
            json!(now),
            json!(now + LIFETIME_MS),
        ],
    )?;
    Ok(json!({"expires_at": now + LIFETIME_MS}))
}

/// Consumes an attempt: answered once, and deleted whatever the answer, so a mismatched or
/// replayed callback also spends it. Outcomes are answers, not errors, so the delete commits.
fn take_flow<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let state = hash(c, "state_hash", &[64])?;
    let binding = hash(c, "binding_hash", &[64])?;
    let provider = provider(c)?;
    let Some(row) = db
        .query(
            "SELECT * FROM oauth_flows WHERE state_hash=?",
            &[json!(state)],
        )?
        .into_iter()
        .next()
    else {
        return Ok(json!({"status":"unknown"}));
    };
    db.query(
        "DELETE FROM oauth_flows WHERE state_hash=?",
        &[json!(state)],
    )?;
    let stored = row["binding_hash"].as_str().unwrap_or_default();
    let bound = bool::from(binding.as_bytes().ct_eq(stored.as_bytes()));
    if row["expires_at"].as_i64().unwrap_or_default() <= now {
        return Ok(json!({"status":"expired"}));
    }
    if !bound || row["provider"] != provider {
        return Ok(json!({"status":"mismatch"}));
    }
    Ok(json!({
        "status": "ok", "verifier": row["verifier"], "nonce": row["nonce"],
        "intent": row["intent"], "account": row["account"], "session_hash": row["session_hash"],
        "return_to": row["return_to"],
    }))
}

fn claim<S: SqlStore>(db: &S, key: &str) -> Result<Option<Value>> {
    let rows = db.query(
        "SELECT account,claimed_at FROM identity_claims WHERE key=?",
        &[json!(key)],
    )?;
    Ok(rows.into_iter().next())
}

/// `identity:<provider>:<subject>` or `email:<64 hex>`.
fn key(c: &Value) -> Result<String> {
    let key = string(c, "key")?;
    let valid = match key.split_once(':') {
        Some(("email", digest)) => {
            digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit())
        }
        Some(("identity", rest)) => rest.split_once(':').is_some_and(|(p, subject)| {
            super::identities::PROVIDERS.contains(&p)
                && !subject.is_empty()
                && subject.len() <= 255
                && subject.bytes().all(|b| b.is_ascii_graphic())
        }),
        _ => false,
    };
    if valid {
        Ok(key)
    } else {
        Err(bad("Invalid identity key"))
    }
}
