//! Personal workspace authority. Only trusted Worker adapters can call these commands.
use crate::storage::{SqlStore, bad, get, save, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};
mod accounts;
mod budget;
mod grants;
mod project_dispatch;
mod project_setup;
mod projects;
mod providers;
mod reviewer;
pub(super) const TABLE: &str = "workspace_records";

/// Apply the workspace schema and execute a command in one synchronous transaction.
/// Passwords enter only the transient command; stored verifiers use Argon2id.
pub fn execute_workspace<S: SqlStore>(store: &S, command: Value) -> Result<Value> {
    migrate(store)?;
    let db = store.clone();
    store.transaction(Box::new(move || {
        let now = command["now"]
            .as_i64()
            .ok_or_else(|| bad("Trusted clock required"))?;
        match string(&command, "op")?.as_str() {
            "reviewer_configure"
            | "reviewer_status"
            | "reviewer_revoke"
            | "reviewer_trial"
            | "reviewer_trial_complete" => reviewer::handle(&db, &command, now),
            "signup" | "login" | "session" | "logout" | "recover" => {
                accounts::handle(&db, &command, now)
            }
            "settings" | "provider_put" | "provider_update" | "provider_delete"
            | "provider_secret" => providers::handle(&db, &command, now),
            "budget_status" | "budget_reserve" | "budget_settle" => {
                budget::handle(&db, &command, now)
            }
            "grants" | "grant_issue" | "grant_check" | "grant_revoke" => {
                grants::handle(&db, &command, now)
            }
            "project_dispatches" => project_dispatch::pending(&db, now),
            "projects"
            | "project_reserve"
            | "project_update"
            | "project_get"
            | "project_delete"
            | "project_claim"
            | "project_progress"
            | "project_retry"
            | "project_schedule"
            | "project_dispatch_sent" => projects::handle(&db, &command, now),
            _ => Err(Error::new("NOT_FOUND", "Unknown workspace operation")),
        }
    }))
}
fn migrate<S: SqlStore>(store: &S) -> Result<()> {
    const SQL: &str = include_str!("../migrations/workspace/0001_accounts.sql");
    store.query("CREATE TABLE IF NOT EXISTS workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)", &[])?;
    let db = store.clone();
    store.transaction(Box::new(move || {
        let applied = db.query(
            "SELECT version,digest FROM workspace_migrations ORDER BY version",
            &[],
        )?;
        let digest = yoneda_core::digest(SQL.as_bytes());
        if applied
            .iter()
            .any(|r| r["version"] != 1 || r["digest"] != digest)
        {
            return Err(Error::new(
                "MIGRATION_DRIFT",
                "Workspace schema version or digest mismatch",
            ));
        }
        if applied.is_empty() {
            for sql in SQL.split(';').filter(|s| !s.trim().is_empty()) {
                db.query(sql, &[])?;
            }
            db.query(
                "INSERT INTO workspace_migrations(version,digest) VALUES(1,?)",
                &[json!(digest)],
            )?;
        }
        Ok(Value::Null)
    }))?;
    Ok(())
}
pub(super) fn audit<S: SqlStore>(db: &S, kind: &str, now: i64, data: Value) -> Result<()> {
    db.query(
        "INSERT INTO workspace_events(kind,at,data) VALUES(?,?,?)",
        &[json!(kind), json!(now), json!(data.to_string())],
    )?;
    Ok(())
}
pub(super) fn account<S: SqlStore>(db: &S) -> Result<Value> {
    get(db, TABLE, "account")
}
pub(super) fn public_account(account: &Value) -> Value {
    json!({"authenticated":true,"username":account["username"],"created_at":account["created_at"],"reviewer":account["reviewer"]})
}
pub(super) fn put<S: SqlStore>(db: &S, id: &str, value: &Value) -> Result<()> {
    save(db, TABLE, id, value)
}
