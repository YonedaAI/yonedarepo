use crate::{execute_workspace, native::NativeStore};
use serde_json::{Value, json};
fn call(db: &NativeStore, mut c: Value) -> yoneda_core::Result<Value> {
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
#[test]
fn reviewer_trial_is_idempotent_one_at_a_time_and_revocable() {
    let db = setup();
    let a = call(&db, json!({"op":"reviewer_trial","id":"trial-one"})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"reviewer_trial","id":"trial-one"})).unwrap(),
        a
    );
    assert_eq!(
        call(&db, json!({"op":"reviewer_trial","id":"trial-two"}))
            .unwrap_err()
            .code,
        "TRIAL_ACTIVE"
    );
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-one"}),
    )
    .unwrap();
    call(&db, json!({"op":"reviewer_trial","id":"trial-two"})).unwrap();
    call(&db, json!({"op":"reviewer_revoke"})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"reviewer_trial","id":"trial-three"}))
            .unwrap_err()
            .code,
        "REVIEWER_EXPIRED"
    );
    assert_eq!(
        call(&db, json!({"op":"budget_reserve","id":"new","amount":1}))
            .unwrap_err()
            .code,
        "REVIEWER_EXPIRED"
    );
}
#[test]
fn peer_awareness_is_lease_bound_and_does_not_return_candidate_source() {
    let db = NativeStore::memory().unwrap();
    let run = |c| crate::execute(&db, c);
    run(json!({"op":"init","now":1000,"id":"peer-repo","name":"Peer test","commit":"a".repeat(40),"remote":{"namespace":"test","name":"test"},"policy":{"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["syntax"],"build":{"setup":[],"checks":[{"name":"syntax","argv":["node","--check","app.js"],"timeout_seconds":10}]}}})).unwrap();
    run(json!({"op":"start_run","now":1000,"id":"peers","intent":"Two independent alternatives","agents":[{"provider":"codex","model":"gpt-5.6-luna","strategy":"one"},{"provider":"claude","model":"claude-sonnet-4-6","strategy":"two"}]})).unwrap();
    let j = run(json!({"op":"claim","now":1000,"job_id":"job:peers:agent-1"})).unwrap();
    let result =
        run(json!({"op":"peer_status","now":1000,"job_id":j["id"],"epoch":j["epoch"]})).unwrap();
    assert_eq!(result["peers"].as_array().unwrap().len(), 2);
    assert!(!result.to_string().contains("diff"));
    assert_eq!(
        run(json!({"op":"peer_status","now":j["lease_until"].as_i64().unwrap()+1,"job_id":j["id"],"epoch":j["epoch"]}))
            .unwrap_err()
            .code,
        "FENCED"
    );
}
