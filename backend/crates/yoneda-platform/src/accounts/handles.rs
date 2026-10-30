//! Handles: the names in URLs (`/<handle>` a profile, `/<handle>/<repository>` a
//! repository). A person's or an org's name is its handle; an account named by an email
//! address (accounts made before sign-up named them by handle) picks one, and that handle's
//! own authority instance (the one a username or org of that name would have) holds an
//! alias to it, so usernames, org names and handles are one namespace with one authority
//! per name. The account keeps the handle it picked (record `handle`); identities and
//! Durable Objects never change. Reserved names (`yoneda_core::account::RESERVED_HANDLES`)
//! are refused to new names of every kind.
use super::op::HandleOp;
use super::*;

const ALIAS: &str = "handle_alias";
const HANDLE: &str = "handle";

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: HandleOp, now: i64) -> Result<Value> {
    match op {
        HandleOp::Reserve => reserve(db, c, now),
        HandleOp::Release => {
            let account = target(c)?;
            if get(db, ALIAS).is_ok_and(|a| a["account"] == account.as_str()) {
                db.query(&format!("DELETE FROM {TABLE} WHERE id=?"), &[json!(ALIAS)])?;
            }
            Ok(json!({ "released": true }))
        }
        HandleOp::Lookup => lookup(db),
        HandleOp::Set => set(db, c, now),
        HandleOp::Get => Ok(json!({ "handle": own(db)? })),
        HandleOp::RepoClaim => super::repo_names::claim(db, c, now),
        HandleOp::RepoRelease => super::repo_names::release(db, c),
        HandleOp::RepoResolve => super::repo_names::resolve(db, c),
    }
}

/// Refuses a new account or org named `name` here: reserved, or held already (an account,
/// an org, a retired org's tombstone, or a handle alias).
pub(super) fn name_free<S: SqlStore>(db: &S, name: &str) -> Result<()> {
    if !name.contains('@') && yoneda_core::account::is_reserved_handle(name) {
        return Err(Error::new(
            "HANDLE_RESERVED",
            format!("{name} is reserved for the website's own pages"),
        ));
    }
    if get(db, "account").is_ok() || get(db, ALIAS).is_ok() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "Username or email unavailable",
        ));
    }
    Ok(())
}

fn target(c: &Value) -> Result<String> {
    yoneda_core::account::normalize_account_identifier(&string(c, "account")?)
}

/// `handle_reserve {handle, account}`, sent to the handle's own instance: holds the handle
/// for the email-named `account` (again for the same account is a no-op).
fn reserve<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let handle = yoneda_core::account::normalize_handle(&string(c, "handle")?)?;
    let account = target(c)?;
    let taken = || Error::new("HANDLE_TAKEN", format!("{handle} is taken"));
    if get(db, "account").is_ok() {
        return Err(taken());
    }
    if let Ok(alias) = get(db, ALIAS) {
        return if alias["account"] == account.as_str() {
            Ok(json!({ "handle": handle }))
        } else {
            Err(taken())
        };
    }
    put(
        db,
        ALIAS,
        &json!({ "handle": handle, "account": account, "at": now }),
    )?;
    Ok(json!({ "handle": handle }))
}

/// `handle_lookup`, on a handle's instance: whose it is (`kind`: user, org or alias, and the
/// `account` identifier its repositories are listed under). NOT_FOUND when nobody holds it.
fn lookup<S: SqlStore>(db: &S) -> Result<Value> {
    if let Ok(a) = get(db, "account") {
        let kind = if a["kind"] == "org" { "org" } else { "user" };
        // A retired org's name resolves to nothing (its tombstone only keeps it unused).
        if kind == "org" && !a["deleted_at"].is_null() {
            return Err(Error::new("NOT_FOUND", "Nobody has that handle"));
        }
        let name = string(&a, "username")?;
        // An email-named account is reached through its alias, never by its address.
        if name.contains('@') {
            return Err(Error::new("NOT_FOUND", "Nobody has that handle"));
        }
        return Ok(json!({ "kind": kind, "account": name, "handle": name }));
    }
    let alias = get(db, ALIAS).map_err(|_| Error::new("NOT_FOUND", "Nobody has that handle"))?;
    Ok(json!({ "kind": "alias", "account": alias["account"], "handle": alias["handle"] }))
}

/// The handle of the account held here: its name, or for an email-named one the handle it
/// picked (null until then).
pub(super) fn own<S: SqlStore>(db: &S) -> Result<Value> {
    let a = get(db, "account")?;
    let name = string(&a, "username")?;
    if !name.contains('@') {
        return Ok(json!(name));
    }
    Ok(get(db, HANDLE).map_or(Value::Null, |h| h["handle"].clone()))
}

/// `handle_set {handle}`, on an email-named account once its handle's instance reserved it:
/// records it, answering the one it replaces (`previous`, for the adapter to release).
fn set<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let handle = yoneda_core::account::normalize_handle(&string(c, "handle")?)?;
    let a = account(db)?;
    if !string(&a, "username")?.contains('@') {
        return Err(Error::new(
            "HANDLE_FIXED",
            "This account's handle is its name",
        ));
    }
    let previous = get(db, HANDLE).ok().map(|h| h["handle"].clone());
    put(db, HANDLE, &json!({ "handle": handle, "at": now }))?;
    audit(db, "account.handle", now, json!({ "handle": handle }))?;
    Ok(json!({ "handle": handle, "previous": previous }))
}
