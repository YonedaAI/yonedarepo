//! Personal access tokens (`ypat_…`): account-wide credentials for CLIs and agents. Only
//! SHA-256 digests of the secret are stored; the Worker hands the secret out once. Every
//! request is checked here (no caching), so a revocation or expiry takes effect at once.
use super::op::TokenOp;
use super::*;
use crate::storage::number;

/// The scope that manages the account's SSH keys and nothing else.
pub(crate) const SSH_KEYS_SCOPE: &str = "account:ssh-keys";
/// Scopes a token may hold; `repo:admin` covers owner operations (`repo_store::auth` maps
/// the `repo:` ones onto a repository's, the Worker enforces the `account:` one).
pub(crate) const SCOPES: [&str; 6] = [
    "repo:read",
    "repo:write",
    "repo:land",
    "repo:review",
    "repo:admin",
    SSH_KEYS_SCOPE,
];
const DAY: i64 = 24 * 60 * 60 * 1000;
const LIVE_LIMIT: usize = 50;
const REPO_LIMIT: usize = 100;
/// `last_used_at` is written at most this often, so checks rarely write.
const USE_RESOLUTION: i64 = 60_000;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: TokenOp, now: i64) -> Result<Value> {
    match op {
        TokenOp::Create => create(db, c, now),
        TokenOp::List => {
            account(db)?;
            let rows = db.query(
                "SELECT * FROM account_tokens WHERE revoked_at IS NULL ORDER BY created_at,id",
                &[],
            )?;
            let listed = |row: &Value| -> Result<Value> {
                let mut token = public(row)?;
                let id = row["id"].as_str().unwrap_or_default();
                token["ssh_keys"] = json!(super::ssh_key_tokens::added_by(db, id)?.len());
                Ok(token)
            };
            Ok(json!({"tokens": rows.iter().map(listed).collect::<Result<Vec<_>>>()?}))
        }
        TokenOp::Check => {
            super::access::refuse_suspended(db)?;
            let row = db
                .query(
                    "SELECT * FROM account_tokens WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?",
                    &[json!(hash(c, "token_hash", &[64])?), json!(now)],
                )?
                .into_iter()
                .next()
                .ok_or_else(|| Error::new("UNAUTHORIZED", "Unknown, expired or revoked token"))?;
            let mut checked = public(&row)?;
            checked["orgs"] = json!(super::orgs::hints(db)?);
            if row["last_used_at"]
                .as_i64()
                .is_none_or(|at| at + USE_RESOLUTION <= now)
            {
                db.query(
                    "UPDATE account_tokens SET last_used_at=? WHERE id=?",
                    &[json!(now), row["id"].clone()],
                )?;
            }
            Ok(checked)
        }
        TokenOp::Revoke => {
            account(db)?;
            let id = string(c, "id")?;
            let found = db.query(
                "SELECT id FROM account_tokens WHERE id=? AND revoked_at IS NULL",
                &[json!(id)],
            )?;
            if found.is_empty() {
                return Err(Error::new("NOT_FOUND", "Unknown token"));
            }
            db.query(
                "UPDATE account_tokens SET revoked_at=? WHERE id=?",
                &[json!(now), json!(id)],
            )?;
            let removed = super::ssh_key_tokens::remove_added_by(db, &id, now)?;
            audit(db, "pat.revoked", now, json!({"id":id}))?;
            Ok(json!({"id":id,"revoked":true,"removed_ssh_keys":removed}))
        }
    }
}

/// What a token grants, validated: `{scopes, repos, org, expires_days}` (repos `null`: all;
/// org `null`: not limited to one organization's repositories).
pub(super) fn grant(c: &Value) -> Result<Value> {
    let scopes: Vec<String> = serde_json::from_value(c["scopes"].clone())
        .map_err(|_| bad("scopes must be a list of token scopes"))?;
    if scopes.is_empty()
        || scopes.len() > SCOPES.len()
        || scopes.iter().any(|s| !SCOPES.contains(&s.as_str()))
    {
        return Err(bad(&format!(
            "Scopes must be some of {}",
            SCOPES.join(", ")
        )));
    }
    let mut unique = scopes.clone();
    unique.sort();
    unique.dedup();
    if unique.len() != scopes.len() {
        return Err(bad("Scopes must not repeat"));
    }
    let repos = match &c["repos"] {
        Value::Null => Value::Null,
        Value::Array(list) => {
            let valid = |v: &Value| {
                v.as_str().is_some_and(|s| {
                    s.len() == 21
                        && s.starts_with('r')
                        && s[1..]
                            .bytes()
                            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
                })
            };
            if list.is_empty() || list.len() > REPO_LIMIT || !list.iter().all(valid) {
                return Err(bad("repos must be 1-100 repository ids, or null for all"));
            }
            Value::Array(list.clone())
        }
        _ => return Err(bad("repos must be a list of repository ids")),
    };
    let org = match &c["org"] {
        Value::Null => Value::Null,
        Value::String(name) => json!(super::orgs::org_name(name)?),
        _ => return Err(bad("org must be an organization name, or null")),
    };
    let days = number(c, "expires_days")?;
    if !(1..=90).contains(&days) {
        return Err(bad("expires_days must be 1-90"));
    }
    Ok(json!({"scopes":scopes,"repos":repos,"org":org,"expires_days":days}))
}

fn create<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    let id = string(c, "id")?;
    if !valid_id(&id) {
        return Err(bad("Invalid token id"));
    }
    let name = string(c, "name")?;
    if name.trim().is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(bad("Token names are 1-64 printable characters"));
    }
    let grant = grant(c)?;
    // Only the device flow labels a token as a login (with the CLI's host).
    let origin = match &c["origin"] {
        Value::Null => None,
        Value::String(origin) if origin == "login" => Some("login"),
        _ => return Err(bad("origin must be login, or null")),
    };
    let host = label(c, "host")?;
    if origin.is_none() && host.is_some() {
        return Err(bad("Only a login token names its host"));
    }
    let live = db.query(
        "SELECT COUNT(*) AS n FROM account_tokens WHERE revoked_at IS NULL AND expires_at>?",
        &[json!(now)],
    )?;
    if live[0]["n"].as_i64().unwrap_or_default() >= LIVE_LIMIT as i64 {
        return Err(bad("Live token limit reached; revoke one first"));
    }
    let expires_at = now + grant["expires_days"].as_i64().unwrap_or(30) * DAY;
    db.query(
        "INSERT INTO account_tokens(id,name,token_hash,scopes,repos,org,origin,host,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        &[
            json!(id),
            json!(name),
            json!(hash(c, "token_hash", &[64])?),
            json!(grant["scopes"].to_string()),
            json!((!grant["repos"].is_null()).then(|| grant["repos"].to_string())),
            grant["org"].clone(),
            json!(origin),
            json!(host),
            json!(now),
            json!(expires_at),
        ],
    )?;
    audit(
        db,
        "pat.created",
        now,
        json!({"id":id,"scopes":grant["scopes"],"repos":grant["repos"],"org":grant["org"],"origin":origin,"host":host}),
    )?;
    let row = db.query("SELECT * FROM account_tokens WHERE id=?", &[json!(id)])?;
    public(row.first().ok_or_else(|| bad("Token was not stored"))?)
}

/// `pat_<16 hex>`.
fn valid_id(id: &str) -> bool {
    id.len() == 20
        && id.starts_with("pat_")
        && id[4..]
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The token a command says it acts with (`token_id`; null: a signed-in person). It must be
/// live here, in the command's transaction: the Worker's check came earlier, and a revocation
/// committed in between would otherwise miss what this command adds.
pub(super) fn acting<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Option<String>> {
    let id = match &c["token_id"] {
        Value::Null => return Ok(None),
        Value::String(id) if valid_id(id) => id,
        _ => return Err(bad("Invalid token id")),
    };
    let live = db.query(
        "SELECT id FROM account_tokens WHERE id=? AND revoked_at IS NULL AND expires_at>?",
        &[json!(id), json!(now)],
    )?;
    if live.is_empty() {
        return Err(Error::new(
            "UNAUTHORIZED",
            "Unknown, expired or revoked token",
        ));
    }
    Ok(Some(id.clone()))
}

/// Revokes every live token (account recovery).
pub(super) fn revoke_all<S: SqlStore>(db: &S, now: i64) -> Result<()> {
    db.query(
        "UPDATE account_tokens SET revoked_at=? WHERE revoked_at IS NULL",
        &[json!(now)],
    )?;
    Ok(())
}

/// A stored token without its digest.
fn public(row: &Value) -> Result<Value> {
    let parse = |key: &str| -> Result<Value> {
        match row[key].as_str() {
            Some(text) => serde_json::from_str(text).map_err(|_| bad("Corrupt token")),
            None => Ok(Value::Null),
        }
    };
    Ok(json!({
        "id": row["id"], "name": row["name"], "scopes": parse("scopes")?, "repos": parse("repos")?,
        "org": row["org"],
        "origin": row["origin"], "host": row["host"],
        "created_at": row["created_at"], "expires_at": row["expires_at"],
        "last_used_at": row["last_used_at"],
    }))
}
