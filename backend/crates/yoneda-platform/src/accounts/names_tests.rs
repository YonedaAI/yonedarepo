//! The account's display name: set by the person, prefilled once from a sign-in provider, never
//! an email address, and the migration.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn at(db: &NativeStore, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(1000);
    execute_workspace(db, command)
}
fn signup(db: &NativeStore, name: Value) {
    at(
        db,
        json!({"op":"identity_signup","username":"octocat","session_hash":"a".repeat(64),
               "provider":"github","subject":"42","login":"octocat","email":"octo@example.com",
               "name":name}),
    )
    .unwrap();
}
fn signin(db: &NativeStore, name: Value) {
    let signed = at(
        db,
        json!({"op":"identity_signin","provider":"github","subject":"42",
               "session_hash":"b".repeat(64),"name":name}),
    )
    .unwrap();
    assert_eq!(signed["authenticated"], true);
}
fn shown(db: &NativeStore) -> Value {
    at(db, json!({"op":"handle_get"})).unwrap()["display_name"].clone()
}
fn set(db: &NativeStore, name: &str) -> yoneda_core::Result<Value> {
    at(db, json!({"op":"name_set","name":name}))
}
fn code(result: yoneda_core::Result<Value>) -> String {
    result.unwrap_err().code
}

#[test]
fn sign_up_brings_the_providers_name() {
    let db = NativeStore::memory().unwrap();
    signup(&db, json!("Ada Lovelace"));
    assert_eq!(shown(&db), "Ada Lovelace");
}

#[test]
fn an_account_without_a_name_is_prefilled_at_its_next_sign_in() {
    let db = NativeStore::memory().unwrap();
    signup(&db, Value::Null);
    assert_eq!(shown(&db), Value::Null);
    signin(&db, json!("Ada Lovelace"));
    assert_eq!(shown(&db), "Ada Lovelace");
}

#[test]
fn linking_a_provider_fills_a_missing_name() {
    let db = NativeStore::memory().unwrap();
    signup(&db, Value::Null);
    at(
        &db,
        json!({"op":"identity_link","session_hash":"a".repeat(64),"provider":"google",
               "subject":"7","login":"ada","email":null,"name":"Ada Lovelace"}),
    )
    .unwrap();
    assert_eq!(shown(&db), "Ada Lovelace");
}

#[test]
fn a_chosen_name_survives_sign_in() {
    let db = NativeStore::memory().unwrap();
    signup(&db, json!("Ada Lovelace"));
    assert_eq!(set(&db, "  Ada  ").unwrap()["display_name"], "Ada");
    signin(&db, json!("Someone Else"));
    assert_eq!(shown(&db), "Ada");
}

#[test]
fn a_cleared_name_stays_cleared() {
    let db = NativeStore::memory().unwrap();
    signup(&db, json!("Ada Lovelace"));
    assert_eq!(set(&db, "   ").unwrap()["display_name"], Value::Null);
    signin(&db, json!("Ada Lovelace"));
    assert_eq!(shown(&db), Value::Null);
}

#[test]
fn a_name_is_one_line_of_plain_text_and_no_email_address() {
    let db = NativeStore::memory().unwrap();
    signup(&db, json!("Ada"));
    for name in [
        "Ada\nLovelace",
        "Ada\tLovelace",
        "ada@example.com",
        "Ada\u{202e}ecalevol",
        &"a".repeat(81),
    ] {
        assert_eq!(code(set(&db, name)), "INVALID_INPUT", "{name:?}");
    }
    assert_eq!(shown(&db), "Ada");
    assert_eq!(
        set(&db, &"é".repeat(80)).unwrap()["display_name"],
        "é".repeat(80)
    );
}

#[test]
fn a_providers_unusable_name_is_no_name_and_never_blocks_sign_in() {
    for bad in [
        json!("ada@example.com"),
        json!("Ada\nL"),
        json!("a".repeat(500)),
        json!(42),
    ] {
        let db = NativeStore::memory().unwrap();
        signup(&db, bad.clone());
        signin(&db, bad);
        assert_eq!(shown(&db), Value::Null);
    }
}

#[test]
fn the_name_is_kept_for_a_person_and_needs_an_account() {
    let db = NativeStore::memory().unwrap();
    assert_eq!(code(set(&db, "Ada")), "NOT_FOUND");
}

#[test]
fn the_name_migration_is_fresh_repeatable_and_upgrades_a_version_eleven_store() {
    let versions = |db: &NativeStore| {
        db.query("SELECT version FROM workspace_migrations", &[])
            .unwrap()
            .len()
    };
    let fresh = NativeStore::memory().unwrap();
    signup(&fresh, json!("Ada"));
    assert_eq!(versions(&fresh), 13);
    assert_eq!(shown(&fresh), "Ada");
    assert_eq!(versions(&fresh), 13);

    let db = NativeStore::memory().unwrap();
    db.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    for (version, sql) in &super::MIGRATIONS[..11] {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
        let digest = yoneda_core::digest(sql.as_bytes());
        db.query(
            "INSERT INTO workspace_migrations(version,digest) VALUES(?,?)",
            &[json!(version), json!(digest)],
        )
        .unwrap();
    }
    signup(&db, json!("Ada"));
    assert_eq!(versions(&db), 13);
    assert_eq!(shown(&db), "Ada");
}
