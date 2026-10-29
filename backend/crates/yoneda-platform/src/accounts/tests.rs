use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(1000);
    execute_workspace(db, command)
}
fn signup(db: &NativeStore) -> Value {
    call(db, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap()
}
#[test]
fn passwords_are_slow_hashed_and_sessions_are_revocable() {
    let db = NativeStore::memory().unwrap();
    assert_eq!(signup(&db)["username"], "alice");
    let storage = json!(
        db.query("SELECT payload FROM workspace_records", &[])
            .unwrap()
    )
    .to_string();
    assert!(!storage.contains("a long test password"));
    assert!(storage.contains("argon2id"));
    assert_eq!(
        call(&db, json!({"op":"session","session_hash":"a".repeat(64)})).unwrap()["authenticated"],
        true
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"login","password":"wrong password","session_hash":"c".repeat(64)})
        )
        .unwrap()["authenticated"],
        false
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"login","password":"a long test password","session_hash":"c".repeat(64)})
        )
        .unwrap()["authenticated"],
        true
    );
    call(&db, json!({"op":"logout","session_hash":"c".repeat(64)})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"session","session_hash":"c".repeat(64)})).unwrap()["authenticated"],
        false
    );
    assert!(call(&db, json!({"op":"signup","username":"alice","password":"another good password","salt":"02".repeat(16),"recovery_hash":"d".repeat(64),"session_hash":"e".repeat(64)})).is_err());
}
#[test]
fn account_exists_only_after_signup() {
    let db = NativeStore::memory().unwrap();
    let exists =
        |db: &NativeStore| call(db, json!({"op":"account_exists"})).unwrap()["exists"].clone();
    assert_eq!(exists(&db), false);
    signup(&db);
    assert_eq!(exists(&db), true);
}
#[test]
fn the_welcome_marker_is_set_once_and_only_on_an_account() {
    let db = NativeStore::memory().unwrap();
    let state = |db: &NativeStore| call(db, json!({"op":"welcome_state"})).unwrap()["sent"].clone();
    assert_eq!(
        call(&db, json!({"op":"welcome_sent"})).unwrap_err().code,
        "NOT_FOUND"
    );
    signup(&db);
    assert_eq!(state(&db), false);
    assert_eq!(
        call(&db, json!({"op":"welcome_sent"})).unwrap()["sent"],
        true
    );
    assert_eq!(state(&db), true);
    // A redelivered job marks it again without error.
    assert_eq!(
        call(&db, json!({"op":"welcome_sent"})).unwrap()["sent"],
        true
    );
}
#[test]
fn recovery_rotates_password_code_and_revokes_all_existing_sessions() {
    let db = NativeStore::memory().unwrap();
    signup(&db);
    assert_eq!(call(&db,json!({"op":"recover","recovery_hash":"f".repeat(64),"password":"new long test password","salt":"02".repeat(16),"new_recovery_hash":"d".repeat(64)})).unwrap()["authenticated"],false);
    assert_eq!(call(&db,json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"new long test password","salt":"02".repeat(16),"new_recovery_hash":"d".repeat(64)})).unwrap()["authenticated"],true);
    assert_eq!(
        call(&db, json!({"op":"session","session_hash":"a".repeat(64)})).unwrap()["authenticated"],
        false
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"login","password":"a long test password","session_hash":"c".repeat(64)})
        )
        .unwrap()["authenticated"],
        false
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"login","password":"new long test password","session_hash":"c".repeat(64)})
        )
        .unwrap()["authenticated"],
        true
    );
    assert_eq!(call(&db,json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"yet another password","salt":"03".repeat(16),"new_recovery_hash":"e".repeat(64)})).unwrap()["authenticated"],false);
}
#[test]
fn a_retained_reviewer_policy_still_bounds_sign_in() {
    let db = NativeStore::memory().unwrap();
    signup(&db);
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES('reviewer_policy',?)",
        &[json!(json!({"expires":2000,"revoked":false}).to_string())],
    )
    .unwrap();
    let session = |now: i64| {
        execute_workspace(
            &db,
            json!({"op":"session","session_hash":"a".repeat(64),"now":now}),
        )
        .unwrap()["authenticated"]
            .clone()
    };
    assert_eq!(session(1999), true);
    assert_eq!(session(2000), false);
    let login = json!({"op":"login","password":"a long test password","session_hash":"c".repeat(64),"now":2001});
    assert_eq!(
        execute_workspace(&db, login).unwrap()["authenticated"],
        false
    );
}

#[test]
fn account_ops_round_trip_and_unknown_ops_are_not_found() {
    use super::op::AccountOp;
    let all = AccountOp::all();
    for op in &all {
        assert_eq!(AccountOp::parse(&json!({"op": op.name()})).unwrap(), *op);
    }
    // What the account adapters send (signup, login and recover are named by the route).
    let sent = crate::ops::worker_op_literals(|source| source.contains("from './workspace'"));
    assert!(sent.len() >= 25, "{}", sent.len());
    for name in sent.iter().filter(|name| !name.starts_with("repo_")) {
        assert!(AccountOp::parse(&json!({ "op": name })).is_ok(), "{name}");
    }
    let db = NativeStore::memory().unwrap();
    let e = call(&db, json!({"op":"nope"})).unwrap_err();
    assert_eq!(
        (e.code.as_str(), e.message.as_str()),
        ("NOT_FOUND", "Unknown workspace operation")
    );
}
