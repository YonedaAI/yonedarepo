//! Personal workspace authority. Only trusted Worker adapters can call these commands.
use crate::storage::{SqlStore, bad, get, save, string};
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result};
mod accounts;
mod budget;
mod campaign;
mod campaign_budget;
mod campaign_runs;
mod campaign_trial;
mod device;
mod grants;
mod project_dispatch;
mod project_platform;
mod project_setup;
mod project_visibility;
mod projects;
mod provider_model_alias;
mod providers;
mod reviewer;
mod spend;
#[cfg(test)]
#[path = "spend/tests.rs"]
mod spend_tests;
mod tokens;
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
            "project_set_visibility" => project_visibility::handle(&db, &command, now),
            "workspace_spend_status"
            | "workspace_spend_configure"
            | "workspace_spend_reserve"
            | "workspace_spend_settle" => spend::handle(&db, &command, now),
            "reviewer_configure"
            | "reviewer_status"
            | "reviewer_revoke"
            | "reviewer_trial"
            | "reviewer_trial_complete"
            | "reviewer_trial_reopen"
            | "reviewer_trial_repair_finish"
            | "reviewer_trial_repair_abort" => reviewer::handle(&db, &command, now),
            "signup" | "login" | "session" | "logout" | "recover" => {
                accounts::handle(&db, &command, now)
            }
            "settings"
            | "provider_put"
            | "provider_update"
            | "provider_delete"
            | "provider_model_alias"
            | "provider_secret" => providers::handle(&db, &command, now),
            "reviewer_campaign_enable"
            | "reviewer_campaign_status"
            | "campaign_configure"
            | "campaign_status"
            | "campaign_enable"
            | "campaign_disable" => campaign::handle(&db, &command, now),
            "campaign_bind_run" | "campaign_run_status" => {
                campaign_runs::handle(&db, &command, now)
            }
            "campaign_trial" | "campaign_trial_status" | "campaign_trial_complete" => {
                campaign_trial::handle(&db, &command, now)
            }
            "campaign_reserve" | "campaign_settle" => campaign_budget::handle(&db, &command, now),
            "budget_status" | "budget_reserve" | "budget_settle" => {
                budget::handle(&db, &command, now)
            }
            "pat_create" | "pat_list" | "pat_check" | "pat_revoke" => {
                tokens::handle(&db, &command, now)
            }
            "device_create" | "device_approve" | "device_poll" => {
                device::handle(&db, &command, now)
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
            | "project_dispatch_sent"
            | "project_platform_bind"
            | "project_platform_credential" => projects::handle(&db, &command, now),
            _ => Err(Error::new("NOT_FOUND", "Unknown workspace operation")),
        }
    }))
}
/// Digest-pinned, forward-only workspace migrations (version, SQL), applied in order.
const MIGRATIONS: [(i64, &str); 2] = [
    (1, include_str!("../migrations/workspace/0001_accounts.sql")),
    (
        2,
        include_str!("../migrations/workspace/0002_account_tokens.sql"),
    ),
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
            let digest = yoneda_agents_core::digest(sql.as_bytes());
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
