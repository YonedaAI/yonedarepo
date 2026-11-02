//! The connected GitHub installation: one an account, replaced by connecting again, nothing but
//! ids and a login, and the migration.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn signed_up() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(
        &db,
        1,
        json!({"op":"signup","username":"ada_l","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)}),
    )
    .unwrap();
    db
}
fn put(id: i64, login: &str) -> Value {
    json!({"op":"github_installation_put","installation":id,"login":login})
}
fn held(db: &NativeStore) -> Value {
    at(db, 9, json!({"op":"github_installation_get"})).unwrap()
}

#[test]
fn an_account_with_none_answers_nothing() {
    assert_eq!(held(&signed_up()), json!({}));
}

#[test]
fn connecting_again_replaces_the_installation() {
    let db = signed_up();
    at(&db, 2, put(7, "ada")).unwrap();
    at(&db, 3, put(8, "ada")).unwrap();
    assert_eq!(
        held(&db),
        json!({"installation":8,"login":"ada","connected_at":3})
    );
}

#[test]
fn refuses_what_is_no_installation() {
    let db = signed_up();
    for bad in [
        json!({"op":"github_installation_put","installation":0,"login":"ada"}),
        json!({"op":"github_installation_put","installation":"7","login":"ada"}),
        put(7, ""),
        put(7, &"a".repeat(40)),
    ] {
        assert_eq!(at(&db, 2, bad).unwrap_err().code, "INVALID_INPUT");
    }
    assert_eq!(held(&db), json!({}));
}

#[test]
fn an_account_that_does_not_exist_holds_none() {
    let db = NativeStore::memory().unwrap();
    assert!(at(&db, 2, put(7, "ada")).is_err());
}

#[test]
fn the_migration_is_fresh_repeatable_and_upgrades_a_version_ten_store() {
    let versions = |db: &NativeStore| {
        db.query("SELECT version FROM workspace_migrations", &[])
            .unwrap()
            .len()
    };
    let fresh = signed_up();
    assert_eq!(versions(&fresh), 11);
    held(&fresh);
    assert_eq!(versions(&fresh), 11);

    // Upgrade: a version-10 store keeps its account and starts with no installation.
    let db = NativeStore::memory().unwrap();
    db.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    let previous = [
        include_str!("migrations/0001_accounts.sql"),
        include_str!("migrations/0002_account_tokens.sql"),
        include_str!("migrations/0003_orgs.sql"),
        include_str!("migrations/0004_team_ids.sql"),
        include_str!("migrations/0005_ssh_keys.sql"),
        include_str!("migrations/0006_token_origin.sql"),
        include_str!("migrations/0007_identities.sql"),
        include_str!("migrations/0008_handles_repo_names.sql"),
        include_str!("migrations/0009_avatars.sql"),
        include_str!("migrations/0010_favorites.sql"),
    ];
    for (version, sql) in previous.iter().enumerate() {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
        db.query(
            "INSERT INTO workspace_migrations(version,digest) VALUES(?,?)",
            &[
                json!(version as i64 + 1),
                json!(yoneda_core::digest(sql.as_bytes())),
            ],
        )
        .unwrap();
    }
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES('account',?)",
        &[json!(
            json!({"username":"ada_l","verifier":null,"created_at":1}).to_string()
        )],
    )
    .unwrap();
    assert_eq!(held(&db), json!({}));
    assert_eq!(versions(&db), 11);
    at(&db, 10, put(7, "ada")).unwrap();
    assert_eq!(held(&db)["installation"], 7);
}
