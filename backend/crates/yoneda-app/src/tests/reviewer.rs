use crate::{execute_workspace, native::NativeStore};
use serde_json::{Value, json};
fn call(db: &NativeStore, mut c: Value) -> yoneda_agents_core::Result<Value> {
    if c.get("now").is_none() {
        c["now"] = json!(1000);
    }
    execute_workspace(db, c)
}
fn setup() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"signup","username":"reviewer","password":"test reviewer password","salt":"01".repeat(16),"session_hash":"a".repeat(64),"recovery_hash":"b".repeat(64)})).unwrap();
    call(
        &db,
        json!({"op":"reviewer_configure","repo_id":"sandbox","expires":1000000}),
    )
    .unwrap();
    db
}
#[test]
fn reviewer_allowance_is_shared_immutable_and_survives_expiry() {
    let db = setup();
    assert_eq!(
        call(&db, json!({"op":"budget_status"})).unwrap()["limit"],
        50000000
    );
    call(
        &db,
        json!({"op":"budget_reserve","id":"one","amount":20000000}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"budget_reserve","id":"two","amount":20000000}),
    )
    .unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"budget_reserve","id":"three","amount":11000000})
        )
        .unwrap_err()
        .code,
        "BUDGET_EXHAUSTED"
    );
    call(
        &db,
        json!({"op":"budget_reserve","id":"one","amount":20000000}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"reviewer_configure","repo_id":"sandbox","expires":1000000}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"budget_status"})).unwrap()["charged"],
        40000000
    );
    assert!(
        call(
            &db,
            json!({"op":"reviewer_configure","repo_id":"other","expires":1000000})
        )
        .is_err()
    );
    assert!(
        !call(
            &db,
            json!({"op":"session","session_hash":"a".repeat(64),"now":1000001})
        )
        .unwrap()["authenticated"]
            .as_bool()
            .unwrap()
    );
    call(
        &db,
        json!({"op":"budget_settle","id":"one","amount":1000000,"now":1000001}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"budget_status"})).unwrap()["charged"],
        21000000
    );
}
