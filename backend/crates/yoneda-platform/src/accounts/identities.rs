//! Sign-in identities from OAuth providers on the account that holds them: creating an
//! account from a first sign-in, signing in with a linked identity, linking one to a
//! signed-in account, listing and unlinking. An identity is its provider's stable user id
//! (`subject`); its email is only a hint the adapter uses to refuse silent merges. The last
//! way to sign in (a password or an identity) is never removed.
use super::op::IdentityOp;
use super::*;

pub(super) const PROVIDERS: [&str; 2] = ["github", "google"];

/// A provider identity as the Worker adapter verified it with the provider.
struct Identity {
    provider: String,
    subject: String,
    login: String,
    email: Option<String>,
}

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: IdentityOp, now: i64) -> Result<Value> {
    match op {
        IdentityOp::Signup => signup(db, c, now),
        IdentityOp::Signin => signin(db, c, now),
        IdentityOp::Link => link(db, c, now),
        IdentityOp::List => {
            let a = account(db)?;
            let rows = db.query(
                "SELECT provider,login,email,created_at,last_used_at FROM account_identities ORDER BY provider",
                &[],
            )?;
            Ok(json!({"identities": rows, "password": has_password(&a)}))
        }
        IdentityOp::Unlink => unlink(db, c, now),
        IdentityOp::Check => {
            let (provider, subject) = (provider(c)?, subject(c)?);
            let linked = account(db).is_ok()
                && held(db, &provider)?.is_some_and(|r| r["subject"] == subject);
            Ok(json!({ "linked": linked }))
        }
    }
}

fn signup<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let username = yoneda_core::account::normalize_account_identifier(&string(c, "username")?)?;
    if username.contains('@') {
        return Err(bad("Accounts from a sign-in provider use a username"));
    }
    if get(db, "account").is_ok() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "Username or email unavailable",
        ));
    }
    let identity = identity(c)?;
    let mut a = json!({"username":username,"verifier":null,"recovery_hash":null,"created_at":now});
    // The provider-verified email is the account's contact email (password sign-ups store
    // theirs under the same field); never part of the public account.
    if let Some(email) = &identity.email {
        a["email"] = json!(email);
    }
    put(db, "account", &a)?;
    insert(db, &identity, now)?;
    super::signin::session(db, c, now)?;
    audit(
        db,
        "account.created",
        now,
        json!({"username":username,"provider":identity.provider}),
    )?;
    Ok(public_account(&a))
}

fn signin<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let denied = json!({"authenticated":false});
    let Ok(a) = account(db) else {
        return Ok(denied);
    };
    let (provider, subject) = (provider(c)?, subject(c)?);
    let linked = held(db, &provider)?.is_some_and(|row| row["subject"] == subject);
    if !linked || !super::access::valid(db, now)? {
        return Ok(denied);
    }
    db.query(
        "UPDATE account_identities SET last_used_at=? WHERE provider=?",
        &[json!(now), json!(provider)],
    )?;
    super::signin::session(db, c, now)?;
    Ok(public_account(&a))
}

/// Links an identity to the account whose live session started the link.
fn link<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    account(db)?;
    let session = get(db, &format!("session:{}", hash(c, "session_hash", &[64])?));
    if !super::access::valid(db, now)?
        || !session.is_ok_and(|s| s["expires"].as_i64().is_some_and(|at| at > now))
    {
        return Err(Error::new(
            "UNAUTHORIZED",
            "Sign in again to link a sign-in provider",
        ));
    }
    let identity = identity(c)?;
    if let Some(row) = held(db, &identity.provider)? {
        if row["subject"] == identity.subject {
            return Ok(json!({"linked":true,"provider":identity.provider}));
        }
        return Err(Error::new(
            "ALREADY_EXISTS",
            "This account already has an identity from that provider; unlink it first",
        ));
    }
    insert(db, &identity, now)?;
    audit(
        db,
        "identity.linked",
        now,
        json!({"provider":identity.provider}),
    )?;
    Ok(json!({"linked":true,"provider":identity.provider}))
}

fn unlink<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let a = account(db)?;
    let provider = provider(c)?;
    let row = held(db, &provider)?.ok_or_else(|| Error::new("NOT_FOUND", "No such identity"))?;
    let identities = db.query("SELECT COUNT(*) AS n FROM account_identities", &[])?[0]["n"]
        .as_i64()
        .unwrap_or_default();
    if identities + i64::from(has_password(&a)) <= 1 {
        return Err(Error::new(
            "LAST_SIGNIN_METHOD",
            "This is the only way to sign in to this account; link another before removing it",
        ));
    }
    db.query(
        "DELETE FROM account_identities WHERE provider=?",
        &[json!(provider)],
    )?;
    audit(db, "identity.unlinked", now, json!({"provider":provider}))?;
    // Whether another identity still carries the email (its claim then stays).
    let email_kept = !row["email"].is_null()
        && !db
            .query(
                "SELECT 1 FROM account_identities WHERE email=?",
                &[row["email"].clone()],
            )?
            .is_empty();
    Ok(
        json!({"provider":provider,"subject":row["subject"],"email":row["email"],"email_kept":email_kept}),
    )
}

/// Removes every identity (account recovery: the owner starts again from the recovery code).
pub(super) fn remove_all<S: SqlStore>(db: &S) -> Result<()> {
    db.query("DELETE FROM account_identities", &[])?;
    Ok(())
}

/// Whether the account signs in with a password (accounts made by a provider have none).
fn has_password(account: &Value) -> bool {
    account["verifier"].is_object()
}

fn held<S: SqlStore>(db: &S, provider: &str) -> Result<Option<Value>> {
    Ok(db
        .query(
            "SELECT subject,email FROM account_identities WHERE provider=?",
            &[json!(provider)],
        )?
        .into_iter()
        .next())
}

fn insert<S: SqlStore>(db: &S, identity: &Identity, now: i64) -> Result<()> {
    db.query(
        "INSERT INTO account_identities(provider,subject,login,email,created_at,last_used_at) VALUES(?,?,?,?,?,?)",
        &[
            json!(identity.provider),
            json!(identity.subject),
            json!(identity.login),
            json!(identity.email),
            json!(now),
            json!(now),
        ],
    )?;
    Ok(())
}

pub(super) fn provider(c: &Value) -> Result<String> {
    let provider = string(c, "provider")?;
    if PROVIDERS.contains(&provider.as_str()) {
        Ok(provider)
    } else {
        Err(bad("Unknown sign-in provider"))
    }
}

/// The provider's user id: printable ASCII, at most 255 bytes (Google's `sub` limit).
fn subject(c: &Value) -> Result<String> {
    printable(c, "subject", 255)
}

fn identity(c: &Value) -> Result<Identity> {
    let email = match c.get("email") {
        None | Some(Value::Null) => None,
        Some(_) => {
            let email = printable(c, "email", 254)?;
            if email.split('@').count() != 2 || email != email.to_ascii_lowercase() {
                return Err(bad("Invalid email"));
            }
            Some(email)
        }
    };
    Ok(Identity {
        provider: provider(c)?,
        subject: subject(c)?,
        login: printable(c, "login", 100)?,
        email,
    })
}

fn printable(c: &Value, key: &str, max: usize) -> Result<String> {
    let value = string(c, key)?;
    if value.len() > max || !value.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(bad(&format!("Invalid {key}")));
    }
    Ok(value)
}
