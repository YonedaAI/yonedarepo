use crate::storage::SqlStore;
use serde_json::json;
use yoneda_core::{Error, Result};

pub(crate) const MIGRATIONS: [(i64, &str); 42] = [
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
    (
        23,
        include_str!("../migrations/repo_store/0023_repo_tombstone.sql"),
    ),
    (
        24,
        include_str!("../migrations/repo_store/0024_checkpoint_refs_digest.sql"),
    ),
    (25, include_str!("../migrations/repo_store/0025_hooks.sql")),
    (
        26,
        include_str!("../migrations/repo_store/0026_members.sql"),
    ),
    (
        27,
        include_str!("../migrations/repo_store/0027_sessions.sql"),
    ),
    (
        28,
        include_str!("../migrations/repo_store/0028_changes.sql"),
    ),
    (
        29,
        include_str!("../migrations/repo_store/0029_txlog_compaction.sql"),
    ),
    (
        30,
        include_str!("../migrations/repo_store/0030_object_bundles.sql"),
    ),
    (31, include_str!("../migrations/repo_store/0031_forks.sql")),
    (
        32,
        include_str!("../migrations/repo_store/0032_releases.sql"),
    ),
    (33, include_str!("../migrations/repo_store/0033_lfs.sql")),
    (
        34,
        include_str!("../migrations/repo_store/0034_session_ids.sql"),
    ),
    (
        35,
        include_str!("../migrations/repo_store/0035_visibility.sql"),
    ),
    (
        36,
        include_str!("../migrations/repo_store/0036_lfs_sweep.sql"),
    ),
    (
        37,
        include_str!("../migrations/repo_store/0037_session_transcripts.sql"),
    ),
    (
        38,
        include_str!("../migrations/repo_store/0038_quarantine.sql"),
    ),
    // Applied after 0040 on repositories that had 0040 first (they are independent).
    (
        39,
        include_str!("../migrations/repo_store/0039_ref_chains.sql"),
    ),
    (
        40,
        include_str!("../migrations/repo_store/0040_memories.sql"),
    ),
    (
        41,
        include_str!("../migrations/repo_store/0041_session_fetch.sql"),
    ),
    (
        42,
        include_str!("../migrations/repo_store/0042_search_text.sql"),
    ),
];

/// The statements of a migration, split at `;`, except within a trigger's `BEGIN … END`;
/// a piece holding only comments is none.
fn statements(sql: &str) -> Vec<String> {
    let code = |piece: &str| {
        piece
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with("--"))
            .collect::<Vec<_>>()
            .join(" ")
    };
    let starts = |piece: &str, word: &str| code(piece).to_ascii_uppercase().starts_with(word);
    let mut out = Vec::new();
    let mut trigger: Option<String> = None;
    for piece in sql.split(';') {
        if let Some(open) = trigger.as_mut() {
            open.push(';');
            open.push_str(piece);
            if starts(piece, "END") {
                out.extend(trigger.take());
            }
        } else if starts(piece, "CREATE TRIGGER") {
            trigger = Some(piece.to_owned());
        } else if !code(piece).is_empty() {
            out.push(piece.to_owned());
        }
    }
    out.extend(trigger);
    out
}

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
        let latest = migrations.last().map_or(0, |(version, _)| *version);
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
            for statement in statements(sql) {
                owned.query(&statement, &[])?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_trigger_body_stays_one_statement() {
        for (version, sql) in MIGRATIONS {
            if sql.to_ascii_uppercase().contains("CREATE TRIGGER") {
                continue;
            }
            let plain: Vec<&str> = sql.split(';').filter(|s| !s.trim().is_empty()).collect();
            assert_eq!(statements(sql), plain, "migration {version}");
        }
        let sql = "-- note\nCREATE TABLE t(a);\nCREATE TRIGGER t_add AFTER INSERT ON t BEGIN\n  \
                   DELETE FROM u;\n  INSERT INTO u VALUES(new.a);\nEND;\nCREATE TABLE u(a)";
        let split = statements(sql);
        assert_eq!(split.len(), 3, "{split:?}");
        assert!(
            split[1].trim_start().starts_with("CREATE TRIGGER")
                && split[1].trim_end().ends_with("END")
        );
    }
}
