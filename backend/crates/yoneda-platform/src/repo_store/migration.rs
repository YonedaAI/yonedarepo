use crate::storage::SqlStore;
use serde_json::json;
use yoneda_core::{Error, Result};

const MIGRATIONS: [(i64, &str); 22] = [
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
    (5, include_str!("../migrations/repo_store/0005_repairs.sql")),
    (
        6,
        include_str!("../migrations/repo_store/0006_land_queue.sql"),
    ),
    (
        7,
        include_str!("../migrations/repo_store/0007_checkpoints.sql"),
    ),
    (
        8,
        include_str!("../migrations/repo_store/0008_bisect_vacuum.sql"),
    ),
    (
        9,
        include_str!("../migrations/repo_store/0009_review_classes.sql"),
    ),
    (
        10,
        include_str!("../migrations/repo_store/0010_token_paths.sql"),
    ),
    (
        11,
        include_str!("../migrations/repo_store/0011_commit_symbols.sql"),
    ),
    (
        12,
        include_str!("../migrations/repo_store/0012_break_glass.sql"),
    ),
    (
        13,
        include_str!("../migrations/repo_store/0013_symbol_contracts.sql"),
    ),
    (
        14,
        include_str!("../migrations/repo_store/0014_staged_objects.sql"),
    ),
    (
        15,
        include_str!("../migrations/repo_store/0015_outbox_dispatch.sql"),
    ),
    (
        16,
        include_str!("../migrations/repo_store/0016_tree_cache.sql"),
    ),
    (
        17,
        include_str!("../migrations/repo_store/0017_object_store_of_record.sql"),
    ),
    (
        18,
        include_str!("../migrations/repo_store/0018_changesets.sql"),
    ),
    (
        19,
        include_str!("../migrations/repo_store/0019_changeset_batches.sql"),
    ),
    (
        20,
        include_str!("../migrations/repo_store/0020_path_modes.sql"),
    ),
    (
        21,
        include_str!("../migrations/repo_store/0021_projected_blobs.sql"),
    ),
    (
        22,
        include_str!("../migrations/repo_store/0022_changeset_commit_facts.sql"),
    ),
];

/// Digest-pinned, forward-only migrations for the platform's own Durable Object.
pub fn migrate_repo_store<S: SqlStore>(db: &S) -> Result<()> {
    migrate_with(db, "repo_schema_migrations", &MIGRATIONS)
}

/// Applies `migrations` in order, recording each version and digest in `table`; refuses a
/// store migrated by a newer binary or one whose applied migrations differ.
pub(crate) fn migrate_with<S: SqlStore>(
    db: &S,
    table: &'static str,
    migrations: &'static [(i64, &'static str)],
) -> Result<()> {
    db.query(
        &format!(
            "CREATE TABLE IF NOT EXISTS {table}(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)"
        ),
        &[],
    )?;
    let owned = db.clone();
    db.transaction(Box::new(move || {
        let latest = migrations.len() as i64;
        let applied = owned.query(
            &format!("SELECT version,digest FROM {table} ORDER BY version"),
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
        for (version, sql) in migrations {
            let digest = yoneda_core::digest(sql.as_bytes());
            if let Some(row) = applied.iter().find(|r| r["version"] == *version) {
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
                &format!("INSERT INTO {table}(version,digest) VALUES(?,?)"),
                &[json!(version), json!(digest)],
            )?;
        }
        Ok(json!({ "version": latest }))
    }))?;
    Ok(())
}
