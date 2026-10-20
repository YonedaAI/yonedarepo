use super::*;
pub fn migrate_source_workspace<S: SqlStore>(db: &S) -> Result<()> {
    db.query("CREATE TABLE IF NOT EXISTS source_schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",&[])?;
    let owned = db.clone();
    db.transaction(Box::new(move || {
        let migrations = [
            (
                1,
                include_str!("../migrations/source_workspace/0001_source_workspace.sql"),
            ),
            (
                2,
                include_str!("../migrations/source_workspace/0002_metadata_rows.sql"),
            ),
        ];
        let rows = owned.query(
            "SELECT version,digest FROM source_schema_migrations ORDER BY version",
            &[],
        )?;
        if rows
            .iter()
            .any(|r| r["version"].as_i64().is_none_or(|v| v > 2))
        {
            return Err(Error::new(
                "SCHEMA_TOO_NEW",
                "Source schema requires a newer binary",
            ));
        }
        for (version, sql) in migrations {
            let digest = yoneda_agents_core::digest(sql.as_bytes());
            if let Some(row) = rows.iter().find(|r| r["version"] == version) {
                if row["digest"] != digest {
                    return Err(Error::new("MIGRATION_DRIFT", "Source migration differs"));
                }
                continue;
            }
            for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
                owned.query(statement, &[])?;
            }
            owned.query(
                "INSERT INTO source_schema_migrations(version,digest) VALUES(?,?)",
                &[json!(version), json!(digest)],
            )?;
        }
        Ok(json!({"version":2}))
    }))?;
    Ok(())
}
