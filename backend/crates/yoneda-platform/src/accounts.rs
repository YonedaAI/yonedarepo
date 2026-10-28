//! The account authority (one WorkspaceAuthority Durable Object per account, and one per
//! device login code): sign-in sessions, personal access tokens and device login. Only
//! trusted Worker adapters can call these commands.
use crate::storage::{SqlStore, bad, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod access;
mod device;
mod orgs;
#[cfg(test)]
mod orgs_tests;
mod signin;
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
        match string(&command, "op")?.as_str() {
            "signup" | "login" | "session" | "logout" | "recover" | "account_exists" => {
                signin::handle(&db, &command, now)
            }
            "pat_create" | "pat_list" | "pat_check" | "pat_revoke" => {
                tokens::handle(&db, &command, now)
            }
            "device_create" | "device_approve" | "device_poll" => {
                device::handle(&db, &command, now)
            }
            "org_create" | "org_access" | "team_exists" | "org_show" | "org_delete"
            | "org_member_put" | "org_member_remove" | "team_create" | "team_delete"
            | "team_member_put" | "team_member_remove" | "org_hint_add" | "org_hint_remove" => {
                orgs::handle(&db, &command, now)
            }
            _ => Err(Error::new("NOT_FOUND", "Unknown workspace operation")),
        }
    }))
}
/// Digest-pinned, forward-only account migrations (version, SQL), applied in order.
const MIGRATIONS: [(i64, &str); 4] = [
    (1, include_str!("accounts/migrations/0001_accounts.sql")),
    (
        2,
        include_str!("accounts/migrations/0002_account_tokens.sql"),
    ),
    (3, include_str!("accounts/migrations/0003_orgs.sql")),
    (4, include_str!("accounts/migrations/0004_team_ids.sql")),
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
