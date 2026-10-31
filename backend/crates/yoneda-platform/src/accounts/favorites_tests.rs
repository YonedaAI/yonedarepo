//! Favorite repositories: saved on the account, idempotent, at most 50, newest first, an org
//! holds none, and the migration.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn repo(n: usize) -> String {
    format!("r{n:020x}")
}
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
fn listed(db: &NativeStore) -> Vec<String> {
    at(db, 9, json!({"op":"favorite_list"})).unwrap()["favorites"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["repo"].as_str().unwrap().to_string())
        .collect()
}
fn add(db: &NativeStore, now: i64, id: &str) -> yoneda_core::Result<Value> {
    at(db, now, json!({"op":"favorite_put","repo":id}))
}

#[test]
fn favorites_list_newest_first_and_adding_again_changes_nothing() {
    let db = signed_up();
    assert_eq!(listed(&db), Vec::<String>::new());
    add(&db, 10, &repo(1)).unwrap();
    add(&db, 20, &repo(2)).unwrap();
    assert_eq!(listed(&db), [repo(2), repo(1)]);
    // Idempotent: the first add's place stands.
    add(&db, 30, &repo(1)).unwrap();
    assert_eq!(listed(&db), [repo(2), repo(1)]);
    let got = at(&db, 9, json!({"op":"favorite_list"})).unwrap();
    assert_eq!(got["favorites"][1]["added_at"], 10);
}

#[test]
fn removing_takes_the_named_repositories_and_an_absent_one_is_no_error() {
    let db = signed_up();
    for n in 1..=3 {
        add(&db, n as i64, &repo(n)).unwrap();
    }
    at(
        &db,
        9,
        json!({"op":"favorite_remove","repos":[repo(1), repo(3), repo(7)]}),
    )
    .unwrap();
    assert_eq!(listed(&db), [repo(2)]);
}

#[test]
fn an_account_keeps_at_most_fifty_and_a_repeat_at_the_limit_still_succeeds() {
    let db = signed_up();
    for n in 1..=50 {
        add(&db, n as i64, &repo(n)).unwrap();
    }
    assert_eq!(listed(&db).len(), 50);
    let refused = add(&db, 60, &repo(51)).unwrap_err();
    assert_eq!(refused.code, "FAVORITES_FULL");
    assert_eq!(listed(&db).len(), 50);
    add(&db, 61, &repo(7)).unwrap();
    at(&db, 62, json!({"op":"favorite_remove","repos":[repo(7)]})).unwrap();
    add(&db, 63, &repo(51)).unwrap();
    assert_eq!(listed(&db)[0], repo(51));
}

#[test]
fn only_a_repository_id_is_saved_and_only_on_a_person() {
    let db = signed_up();
    for bad in ["", "parser", "r123", "../secrets", &"r".repeat(21)] {
        assert_eq!(
            add(&db, 10, bad).unwrap_err().code,
            "INVALID_INPUT",
            "{bad}"
        );
    }
    let bad = at(&db, 10, json!({"op":"favorite_remove","repos":["parser"]})).unwrap_err();
    assert_eq!(bad.code, "INVALID_INPUT");
    let none = NativeStore::memory().unwrap();
    assert_eq!(add(&none, 10, &repo(1)).unwrap_err().code, "NOT_FOUND");
    assert_eq!(
        at(&none, 10, json!({"op":"favorite_list"}))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
}

#[test]
fn the_favorites_migration_is_fresh_repeatable_and_upgrades_a_version_nine_store() {
    let versions = |db: &NativeStore| {
        db.query("SELECT version FROM workspace_migrations", &[])
            .unwrap()
            .len()
    };
    // Fresh, then repeated by the next command.
    let fresh = signed_up();
    assert_eq!(versions(&fresh), 10);
    listed(&fresh);
    assert_eq!(versions(&fresh), 10);

    // Upgrade: a version-9 store keeps its account and starts with no favorites.
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
    assert_eq!(listed(&db), Vec::<String>::new());
    assert_eq!(versions(&db), 10);
    add(&db, 10, &repo(1)).unwrap();
    assert_eq!(listed(&db), [repo(1)]);
}
