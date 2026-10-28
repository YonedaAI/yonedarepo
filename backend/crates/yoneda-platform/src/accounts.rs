//! The account authority (one WorkspaceAuthority Durable Object per account, one per
//! device login code and one per SSH key fingerprint): sign-in sessions, personal access
//! tokens, SSH keys and device login. Only trusted Worker adapters can call these commands.
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod access;
mod device;
mod op;
mod orgs;
#[cfg(test)]
mod orgs_tests;
mod signin;
mod ssh_keys;
#[cfg(test)]
mod ssh_keys_tests;
mod teams;
#[cfg(test)]
mod tests;
mod tokens;
#[cfg(test)]
mod tokens_tests;
const TABLE: &str = "workspace_records";

/// Apply the account schema and execute a command in one synchronous transaction.
/// Passwords enter only the transient command; stored verifiers use Argon2id.
pub fn execute_workspace<S: SqlStore>(store: &S, command: Value) -> Result<Value> {
    migrate(store)?;
    let db = store.clone();
    store.transaction(Box::new(move || {
        let now = command["now"]
            .as_i64()
            .ok_or_else(|| bad("Trusted clock required"))?;
        match op::AccountOp::parse(&command)? {
            op::AccountOp::Signin(op) => signin::handle(&db, &command, op, now),
            op::AccountOp::Token(op) => tokens::handle(&db, &command, op, now),
            op::AccountOp::Ssh(op) => ssh_keys::handle(&db, &command, op, now),
            op::AccountOp::Device(op) => device::handle(&db, &command, op, now),
            op::AccountOp::Org(op) => orgs::handle(&db, &command, op, now),
            op::AccountOp::OrgMember(op) => orgs::member(&db, &command, op, now),
        }
    }))
}
/// Digest-pinned, forward-only account migrations (version, SQL), applied in order.
const MIGRATIONS: [(i64, &str); 5] = [
    (1, include_str!("accounts/migrations/0001_accounts.sql")),
    (
        2,
        include_str!("accounts/migrations/0002_account_tokens.sql"),
    ),
    (3, include_str!("accounts/migrations/0003_orgs.sql")),
    (4, include_str!("accounts/migrations/0004_team_ids.sql")),
    (5, include_str!("accounts/migrations/0005_ssh_keys.sql")),
];
fn migrate<S: SqlStore>(store: &S) -> Result<()> {
    store.query("CREATE TABLE IF NOT EXISTS workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)", &[])?;
    let db = store.clone();
    store.transaction(Box::new(move || {
        let applied = db.query(
            "SELECT version,digest FROM workspace_migrations ORDER BY version",
            &[],
        )?;
        let latest = MIGRATIONS.len() as i64;
        if applied
            .iter()
            .any(|r| r["version"].as_i64().is_none_or(|v| v > latest))
        {
            return Err(Error::new(
                "SCHEMA_TOO_NEW",
                "Workspace schema requires a newer binary",
            ));
        }
        for (version, sql) in MIGRATIONS {
            let digest = yoneda_core::digest(sql.as_bytes());
            if let Some(row) = applied.iter().find(|r| r["version"] == version) {
                if row["digest"] != digest {
                    return Err(Error::new(
                        "MIGRATION_DRIFT",
                        "Workspace schema version or digest mismatch",
                    ));
                }
                continue;
            }
            for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
                db.query(statement, &[])?;
            }
            db.query(
                "INSERT INTO workspace_migrations(version,digest) VALUES(?,?)",
                &[json!(version), json!(digest)],
            )?;
        }
        Ok(Value::Null)
    }))?;
    Ok(())
}
fn audit<S: SqlStore>(db: &S, kind: &str, now: i64, data: Value) -> Result<()> {
    db.query(
        "INSERT INTO workspace_events(kind,at,data) VALUES(?,?,?)",
        &[json!(kind), json!(now), json!(data.to_string())],
    )?;
    Ok(())
}
/// A stored record by id (`account`, `session:<digest>`, `login_rate`).
fn get<S: SqlStore>(db: &S, id: &str) -> Result<Value> {
    let rows = db.query(
        &format!("SELECT payload FROM {TABLE} WHERE id=?"),
        &[json!(id)],
    )?;
    let row = rows
        .first()
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Unknown record {id}")))?;
    serde_json::from_str(
        row["payload"]
            .as_str()
            .ok_or_else(|| bad("Corrupt payload"))?,
    )
    .map_err(|e| Error::new("DATABASE", e.to_string()))
}
fn put<S: SqlStore>(db: &S, id: &str, value: &Value) -> Result<()> {
    db.query(
        &format!("INSERT INTO {TABLE}(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload"),
        &[json!(id), json!(value.to_string())],
    )?;
    Ok(())
}
/// A hex digest field of one of the given lengths.
fn hash(v: &Value, key: &str, lengths: &[usize]) -> Result<String> {
    let s = string(v, key)?;
    if !lengths.contains(&s.len()) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad(&format!("Invalid {key} digest")));
    }
    Ok(s)
}
/// The person this authority holds (never an org: nobody signs in as one).
fn account<S: SqlStore>(db: &S) -> Result<Value> {
    get(db, "account").and_then(|a| {
        if a["kind"] == "org" {
            Err(Error::new("NOT_FOUND", "Unknown record account"))
        } else {
            Ok(a)
        }
    })
}
fn public_account(account: &Value) -> Value {
    json!({"authenticated":true,"username":account["username"],"created_at":account["created_at"]})
}
