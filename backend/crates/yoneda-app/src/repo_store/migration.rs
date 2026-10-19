use crate::storage::SqlStore;
use serde_json::json;
use yoneda_core::{Error, Result};

const MIGRATIONS: [(i64, &str); 4] = [
    (1, include_str!("../migrations/repo_store/0001_source.sql")),
    (
        2,
        include_str!("../migrations/repo_store/0002_check_runs.sql"),
    ),
    (
        3,
        include_str!("../migrations/repo_store/0003_repo_name.sql"),
    ),
    (
        4,
        include_str!("../migrations/repo_store/0004_projection_import.sql"),
    ),
];

/// Digest-pinned, forward-only migrations for the platform's own Durable Object.
pub fn migrate_repo_store<S: SqlStore>(db: &S) -> Result<()> {
    db.query(
        "CREATE TABLE IF NOT EXISTS repo_schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )?;
    let owned = db.clone();
    db.transaction(Box::new(move || {
        let latest = MIGRATIONS.len() as i64;
        let applied = owned.query(
            "SELECT version,digest FROM repo_schema_migrations ORDER BY version",
            &[],
        )?;
        if applied
            .iter()
            .any(|r| r["version"].as_i64().is_none_or(|v| v > latest))
        {
            return Err(Error::new(
                "SCHEMA_TOO_NEW",
                "Repository schema requires a newer binary",
            ));
        }
        for (version, sql) in MIGRATIONS {
            let digest = yoneda_core::digest(sql.as_bytes());
            if let Some(row) = applied.iter().find(|r| r["version"] == version) {
                if row["digest"] != digest {
                    return Err(Error::new(
                        "MIGRATION_DRIFT",
                        "An applied repository migration differs from the committed one",
                    ));
                }
                continue;
            }
            for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
                owned.query(statement, &[])?;
            }
            owned.query(
                "INSERT INTO repo_schema_migrations(version,digest) VALUES(?,?)",
                &[json!(version), json!(digest)],
            )?;
        }
        Ok(json!({ "version": latest }))
    }))?;
    Ok(())
}
