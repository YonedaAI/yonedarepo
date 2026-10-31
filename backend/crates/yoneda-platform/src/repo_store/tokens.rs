//! Repository tokens (`yrp_…`): the owner (or an admin) creates, revokes and lists them;
//! only their digest is stored. `auth` resolves them to actors.
use super::audit_outbox;
use super::auth::{Actor, token_digest};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub const SCOPES: [&str; 5] = ["read", "write", "check", "review", "land"];

/// One of `SCOPES`, or `check:<name>`: beside `check`, the token may post that required check
/// where the policy binds no posters (`Policy::may_post`). Only an owner mints one, and an
/// owner may post the check anyway.
fn valid_scope(scope: &str) -> bool {
    SCOPES.contains(&scope)
        || scope
            .strip_prefix("check:")
            .is_some_and(|name| super::rows::check_name(name).is_ok())
}

pub fn create_token<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    actor.require_owner()?;
    let name = string(c, "name")?;
    super::rows::check_name(&name)?;
    let secret = string(c, "_secret")?;
    if secret.len() < 32 {
        return Err(bad("Token secret is too short"));
    }
    let scopes: Vec<String> =
        serde_json::from_value(c["scopes"].clone()).map_err(|_| bad("scopes must be a list"))?;
    let grant = super::grants::parse(&c["paths"])?;
    if scopes.is_empty() || scopes.iter().any(|s| !valid_scope(s)) {
        return Err(bad(
            "Scopes must be some of read, write, check, review, land, check:<name>",
        ));
    }
    if !db
        .query("SELECT name FROM tokens WHERE name=?", &[json!(name)])?
        .is_empty()
    {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "A token with this name exists",
        ));
    }
    db.query(
        "INSERT INTO tokens(name,digest,scopes,created_by,created_at,paths) VALUES(?,?,?,?,?,?)",
        &[
            json!(name),
            json!(token_digest(&secret)),
            json!(json!(scopes).to_string()),
            json!(actor.principal),
            json!(number(c, "now")?),
            json!(grant.as_ref().map(|g| json!(g).to_string())),
        ],
    )?;
    let event = json!({ "token": name, "scopes": scopes });
    audit_outbox::record(db, c, "repo.token_created", &actor.principal, event)?;
    Ok(
        json!({ "name": name, "principal": format!("token:{name}"), "scopes": scopes, "paths": grant }),
    )
}

pub fn revoke_token<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    actor.require_owner()?;
    let name = string(c, "name")?;
    let revoked = db.query(
        "UPDATE tokens SET revoked_at=? WHERE name=? AND revoked_at IS NULL RETURNING name",
        &[json!(number(c, "now")?), json!(name)],
    )?;
    if !revoked.is_empty() {
        let event = json!({ "token": name });
        audit_outbox::record(db, c, "repo.token_revoked", &actor.principal, event)?;
    }
    Ok(json!({ "name": name, "revoked": true }))
}

pub fn list_tokens<S: SqlStore>(db: &S, actor: &Actor) -> Result<Value> {
    actor.require_owner()?;
    Ok(
        json!({ "tokens": db.query("SELECT name,scopes,paths,created_by,created_at,revoked_at FROM tokens ORDER BY name", &[])? }),
    )
}
