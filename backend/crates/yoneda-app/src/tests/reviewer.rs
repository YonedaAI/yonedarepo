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
fn repair_receipt() -> Value {
    json!({"request_id":"repair-request-123456","fingerprint":"a".repeat(64)})
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
    let epoch = call(&db, json!({"op":"reviewer_status"})).unwrap()["trial_epoch"].clone();
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-one","expected_epoch":epoch}),
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
fn reviewer_trial_reopen_restores_only_the_existing_lock_without_changing_budget() {
    let db = setup();
    let trial = call(&db, json!({"op":"reviewer_trial","id":"trial-reopen"})).unwrap();
    call(
        &db,
        json!({"op":"budget_reserve","id":"preserved-spend","amount":1234}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-reopen","expected_epoch":call(&db,json!({"op":"reviewer_status"})).unwrap()["trial_epoch"]}),
    )
    .unwrap();
    let budget = call(&db, json!({"op":"budget_status"})).unwrap();
    assert_eq!(
        call(
            &db,
        json!({"op":"reviewer_trial_reopen","id":"changed-trial", "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)})
        )
        .unwrap_err()
        .code,
        "NOT_FOUND"
    );

    let reopened = call(
        &db,
        json!({"op":"reviewer_trial_reopen","id":"trial-reopen", "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)}),
    )
    .unwrap();
    assert_eq!(reopened["id"], trial["id"]);
    assert_eq!(reopened["repo_id"], trial["repo_id"]);
    assert_eq!(reopened["active_trial"], trial["id"]);
    assert_eq!(reopened["status"], "reopened");
    assert_eq!(
        call(
            &db,
            json!({"op":"reviewer_trial_reopen","id":"trial-reopen", "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)})
        )
        .unwrap(),
        reopened
    );
    assert_eq!(
        call(&db, json!({"op":"reviewer_status"})).unwrap()["active_trial"],
        trial["id"]
    );
    assert_eq!(call(&db, json!({"op":"budget_status"})).unwrap(), budget);
    assert_eq!(
        call(&db, json!({"op":"reviewer_trial","id":"new-trial"}))
            .unwrap_err()
            .code,
        "TRIAL_ACTIVE"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"reviewer_trial_reopen","id":"another-trial", "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)})
        )
        .unwrap_err()
        .code,
        "TRIAL_ACTIVE"
    );
    call(&db, json!({"op":"reviewer_revoke"})).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"reviewer_trial_reopen","id":"trial-reopen", "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)})
        )
        .unwrap_err()
        .code,
        "REVIEWER_EXPIRED"
    );
}

#[test]
fn stale_terminal_completion_cannot_clear_an_intervening_repair_lock() {
    let db = setup();
    call(&db, json!({"op":"reviewer_trial","id":"trial-race"})).unwrap();
    let observed_epoch = call(&db, json!({"op":"reviewer_status"})).unwrap()["trial_epoch"]
        .as_i64()
        .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-race","expected_epoch":observed_epoch}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_reopen","id":"trial-race","now":1100, "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)}),
    )
    .unwrap();
    let pending = call(&db, json!({"op":"reviewer_status","now":1100})).unwrap();
    assert_eq!(pending["_active_trial_status"], "repair_pending");
    let pending_epoch = pending["trial_epoch"].as_i64().unwrap();
    let mut wrong_receipt = repair_receipt();
    wrong_receipt["request_id"] = json!("other-request-123456");
    assert_eq!(
        call(&db, json!({"op":"reviewer_trial_repair_abort","id":"trial-race","request_id":wrong_receipt["request_id"],"fingerprint":wrong_receipt["fingerprint"],"now":1100})).unwrap_err().code,
        "TRIAL_ACTIVE"
    );

    // This models status having read the old terminal run before repair began.
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-race","expected_epoch":observed_epoch,"now":1101}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"reviewer_status","now":1101})).unwrap()["active_trial"],
        "trial-race"
    );

    call(
        &db,
        json!({"op":"reviewer_trial_repair_finish","id":"trial-race","now":1102, "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-race","expected_epoch":pending_epoch,"now":1103}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"reviewer_status","now":1103})).unwrap()["active_trial"],
        "trial-race"
    );
}

#[test]
fn active_trial_repair_fences_terminal_status_snapshot_before_repository_mutation() {
    let db = setup();
    call(&db, json!({"op":"reviewer_trial","id":"trial-active-race"})).unwrap();
    let stale_epoch = call(&db, json!({"op":"reviewer_status"})).unwrap()["trial_epoch"]
        .as_i64()
        .unwrap();
    let receipt = repair_receipt();
    call(
        &db,
        json!({"op":"reviewer_trial_reopen","id":"trial-active-race","request_id":receipt["request_id"],"fingerprint":receipt["fingerprint"]}),
    )
    .unwrap();
    let pending = call(&db, json!({"op":"reviewer_status"})).unwrap();
    let pending_epoch = pending["trial_epoch"].as_i64().unwrap();
    assert_ne!(pending_epoch, stale_epoch);

    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-active-race","expected_epoch":stale_epoch}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_repair_finish","id":"trial-active-race","request_id":receipt["request_id"],"fingerprint":receipt["fingerprint"]}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-active-race","expected_epoch":pending_epoch}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"reviewer_status"})).unwrap()["active_trial"],
        "trial-active-race"
    );
}

#[test]
fn interrupted_pending_repair_expires_without_resetting_trial_budget() {
    let db = setup();
    call(&db, json!({"op":"reviewer_trial","id":"trial-expire"})).unwrap();
    let epoch = call(&db, json!({"op":"reviewer_status"})).unwrap()["trial_epoch"]
        .as_i64()
        .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"trial-expire","expected_epoch":epoch}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_reopen","id":"trial-expire","now":1100, "request_id":"repair-request-123456", "fingerprint":"a".repeat(64)}),
    )
    .unwrap();
    let reopened_epoch =
        call(&db, json!({"op":"reviewer_status","now":1100})).unwrap()["trial_epoch"]
            .as_i64()
            .unwrap();
    call(&db, json!({"op":"reviewer_trial_complete","id":"trial-expire","expected_epoch":reopened_epoch,"now":1200})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"reviewer_status","now":1200})).unwrap()["active_trial"],
        "trial-expire"
    );
    call(&db, json!({"op":"reviewer_trial_complete","id":"trial-expire","expected_epoch":reopened_epoch,"now":121101})).unwrap();
    assert!(
        call(&db, json!({"op":"reviewer_status","now":121101})).unwrap()["active_trial"].is_null()
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
