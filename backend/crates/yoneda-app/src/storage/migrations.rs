//! Digest-pinned forward-only ledger migrations, shared by native and Durable Object stores.
use super::SqlStore;
use serde_json::json;
use yoneda_core::{Error, Result};

pub fn migrate<S: SqlStore>(store: &S) -> Result<()> {
    const SCHEMA_VERSION: i64 = 14;
    store.query("CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",&[])?;
    let owned = store.clone();
    store.transaction(Box::new(move || {
        let migrations = [
            (1, include_str!("../migrations/0001_ledger.sql")),
            (2, include_str!("../migrations/0002_run_index.sql")),
            (3, include_str!("../migrations/0003_execution_graph.sql")),
            (4, include_str!("../migrations/0004_state_graph.sql")),
            (5, include_str!("../migrations/0005_model_reservations.sql")),
            (6, include_str!("../migrations/0006_execution_logs.sql")),
            (7, include_str!("../migrations/0007_context_access.sql")),
            (8, include_str!("../migrations/0008_team_runs.sql")),
            (9, include_str!("../migrations/0009_history_archive.sql")),
            (10, include_str!("../migrations/0010_conflicts.sql")),
            (
                11,
                include_str!("../migrations/0011_archive_compaction.sql"),
            ),
            (
                12,
                include_str!("../migrations/0012_history_provenance_indexes.sql"),
            ),
            (13, include_str!("../migrations/0013_autonomous_work.sql")),
            (14, include_str!("../migrations/0014_source_path_lists.sql")),
        ];
        let applied = owned.query(
            "SELECT version,digest FROM schema_migrations ORDER BY version",
            &[],
        )?;
        if applied
            .iter()
            .any(|v| v["version"].as_i64().unwrap_or_default() > SCHEMA_VERSION)
        {
            return Err(Error::new(
                "SCHEMA_TOO_NEW",
                "Database schema requires a newer binary",
            ));
        }
        for (version, sql) in migrations {
            let digest = yoneda_core::digest(sql.as_bytes());
            if let Some(existing) = applied.iter().find(|v| v["version"] == version) {
                if existing["digest"] != digest {
                    return Err(Error::new(
                        "MIGRATION_DRIFT",
                        "An applied migration differs from the committed migration",
                    ));
                }
                continue;
            }
            for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
                owned.query(statement, &[])?;
            }
            owned.query(
                "INSERT INTO schema_migrations(version,digest) VALUES(?,?)",
                &[json!(version), json!(digest)],
            )?;
        }
        Ok(json!({"version":SCHEMA_VERSION}))
    }))?;
    Ok(())
}
