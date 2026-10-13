use super::*;
use crate::storage::*;

#[test]
fn real_version_twelve_upgrades_without_changing_history_and_repeats() {
    let db = NativeStore::memory().unwrap();
    db.query(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    let sqls = [
        include_str!("../migrations/0001_ledger.sql"),
        include_str!("../migrations/0002_run_index.sql"),
        include_str!("../migrations/0003_execution_graph.sql"),
        include_str!("../migrations/0004_state_graph.sql"),
        include_str!("../migrations/0005_model_reservations.sql"),
        include_str!("../migrations/0006_execution_logs.sql"),
        include_str!("../migrations/0007_context_access.sql"),
        include_str!("../migrations/0008_team_runs.sql"),
        include_str!("../migrations/0009_history_archive.sql"),
        include_str!("../migrations/0010_conflicts.sql"),
        include_str!("../migrations/0011_archive_compaction.sql"),
        include_str!("../migrations/0012_history_provenance_indexes.sql"),
    ];
    for (index, sql) in sqls.into_iter().enumerate() {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
        db.query(
            "INSERT INTO schema_migrations(version,digest) VALUES(?,?)",
            &[json!(index + 1), json!(yoneda_core::digest(sql.as_bytes()))],
        )
        .unwrap();
    }
    let historic =
        json!({"id":"old-run","status":"accepted","intent":"Retain the actual historic goal"});
    save(&db, "runs", "old-run", &historic).unwrap();
    migrate(&db).unwrap();
    assert_eq!(get(&db, "runs", "old-run").unwrap(), historic);
    let branch = json!({"id":"development","working_commit":"b".repeat(40),"version":1});
    save(&db, "working_branches", "development", &branch).unwrap();
    db.query(
        "INSERT INTO peer_messages(id,run_id,recipient,payload) VALUES(?,?,?,?)",
        &[
            json!("message"),
            json!("old-run"),
            json!("team"),
            json!("{}"),
        ],
    )
    .unwrap();
    migrate(&db).unwrap();
    assert_eq!(get(&db, "working_branches", "development").unwrap(), branch);
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM peer_messages", &[])
            .unwrap()[0]["count"],
        1
    );
    assert_eq!(
        db.query("SELECT MAX(version) AS version FROM schema_migrations", &[])
            .unwrap()[0]["version"],
        13
    );
}
