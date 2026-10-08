use crate::{SqlStore, execute_workspace, native::NativeStore};
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
fn provider_settings_expose_configuration_without_ciphertext_or_keys() {
    let db = NativeStore::memory().unwrap();
    signup(&db);
    call(&db,json!({"op":"provider_put","provider":"mimo","model":"mimo-v2-flash","sealed":{"iv":"encoded","ciphertext":"encrypted-secret"}})).unwrap();
    let settings = call(&db, json!({"op":"settings"})).unwrap();
    assert_eq!(settings["providers"][0]["model"], "mimo-v2-flash");
    assert!(!settings.to_string().contains("encrypted-secret"));
    assert_eq!(
        call(&db, json!({"op":"provider_secret","provider":"mimo"})).unwrap()["sealed"]["ciphertext"],
        "encrypted-secret"
    );
    call(&db, json!({"op":"provider_delete","provider":"mimo"})).unwrap();
    assert!(call(&db, json!({"op":"provider_secret","provider":"mimo"})).is_err());
}
#[test]
fn claude_budget_is_idempotent_shared_and_does_not_release_unknown_usage() {
    let db = NativeStore::memory().unwrap();
    let reserve = json!({"op":"budget_reserve","id":"parallel-a","amount":12_000_000});
    call(&db, reserve.clone()).unwrap();
    call(&db, reserve).unwrap();
    assert_eq!(
        call(&db, json!({"op":"budget_status"})).unwrap()["charged"],
        12_000_000
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"budget_reserve","id":"parallel-b","amount":9_000_000})
        )
        .unwrap_err()
        .code,
        "BUDGET_EXHAUSTED"
    );
    call(
        &db,
        json!({"op":"budget_settle","id":"parallel-a","amount":2_000_000}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"budget_settle","id":"parallel-a","amount":2_000_000}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"budget_reserve","id":"parallel-b","amount":18_000_000}),
    )
    .unwrap();
    assert_eq!(
        call(&db.clone(), json!({"op":"budget_status"})).unwrap()["charged"],
        20_000_000
    );
    assert!(
        call(
            &db,
            json!({"op":"budget_reserve","id":"parallel-c","amount":1})
        )
        .is_err()
    );
}

#[test]
fn project_reservations_validate_policy_and_resume_without_changing_identity() {
    let db = NativeStore::memory().unwrap();
    signup(&db);
    let request = json!({"op":"project_reserve","id":"project-one","name":"Portfolio","policy":{"version":"site-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}});
    call(&db, request.clone()).unwrap();
    assert_eq!(call(&db, request.clone()).unwrap()["id"], "project-one");
    let mut changed = request.clone();
    changed["name"] = json!("Other project");
    assert!(call(&db, changed).is_err());
    let mut invalid = request;
    invalid["id"] = json!("invalid");
    invalid["policy"]["build"]["checks"] = json!([]);
    assert!(call(&db, invalid).is_err());
    assert_eq!(
        call(&db, json!({"op":"projects"})).unwrap()["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn repository_grants_are_bounded_hashed_revocable_and_recovery_invalidates_them() {
    let db = NativeStore::memory().unwrap();
    signup(&db);
    call(&db,json!({"op":"project_reserve","id":"repo-one","name":"One","policy":yoneda_core::Policy::default()})).unwrap();
    call(
        &db,
        json!({"op":"project_update","id":"repo-one","status":"ready"}),
    )
    .unwrap();
    let grant = json!({"op":"grant_issue","id":"grant-1234567890123456","repo":"repo-one","scope":"contribute","label":"Laptop agent","token_hash":"c".repeat(64),"expires":100000});
    let issued = call(&db, grant.clone()).unwrap();
    assert!(issued.get("token_hash").is_none());
    let check = json!({"op":"grant_check","id":grant["id"],"token_hash":"c".repeat(64)});
    assert_eq!(call(&db, check.clone()).unwrap()["repo"], "repo-one");
    let mut expired = check.clone();
    expired["now"] = json!(100000);
    assert!(execute_workspace(&db, expired).is_err());
    let mut wrong = check.clone();
    wrong["token_hash"] = json!("d".repeat(64));
    assert!(call(&db, wrong).is_err());
    let mut admin = grant.clone();
    admin["scope"] = json!("admin");
    assert!(call(&db, admin).is_err());
    call(&db, json!({"op":"grant_revoke","id":grant["id"]})).unwrap();
    assert!(call(&db, check).is_err());
    let mut second = grant;
    second["id"] = json!("grant-2234567890123456");
    call(&db, second.clone()).unwrap();
    call(&db,json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"replacement password","salt":"02".repeat(16),"new_recovery_hash":"e".repeat(64)})).unwrap();
    assert!(
        call(
            &db,
            json!({"op":"grant_check","id":second["id"],"token_hash":"c".repeat(64)})
        )
        .is_err()
    );
}
