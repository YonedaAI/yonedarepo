use crate::{SqlStore, execute_workspace, native::NativeStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut c: Value) -> yoneda_agents_core::Result<Value> {
    c["now"] = json!(1000);
    execute_workspace(db, c)
}
fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"signup","username":"alice","password":"long synthetic password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    db
}
fn put(db: &NativeStore, id: &str, value: Value) {
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES(?,?)",
        &[json!(id), json!(value.to_string())],
    )
    .unwrap();
}
fn seed(db: &NativeStore, overlap: &str) {
    put(db, "budget", json!({"limit":20000000,"charged":2000}));
    put(
        db,
        &format!("reservation:{overlap}"),
        json!({"reserved":1000,"charged":1000,"status":"settled"}),
    );
    put(
        db,
        "reservation:other",
        json!({"reserved":1000,"charged":1000,"status":"reserved"}),
    );
    put(
        db,
        "campaign:old",
        json!({"id":"old","charged_microusd":3000}),
    );
    put(db, "campaign:old:chain:x", json!({"charged_microusd":3000}));
    put(
        db,
        "campaign:old:approval:1",
        json!({"limit_microusd":12000000}),
    );
    put(
        db,
        &format!("campaign-reservation:{overlap}"),
        json!({"identity":{"binding":{"id":"old"}},"charged_microusd":1000,"status":"settled"}),
    );
    put(
        db,
        "campaign-reservation:separate",
        json!({"identity":{"binding":{"id":"old"}},"charged_microusd":2000,"status":"reserved"}),
    );
}
fn status(db: &NativeStore) -> Value {
    call(db, json!({"op":"workspace_spend_status"})).unwrap()
}
fn configure(db: &NativeStore, expected: i64, limit: i64) -> yoneda_agents_core::Result<Value> {
    call(
        db,
        json!({"op":"workspace_spend_configure","expected_version":expected,"limit_microusd":limit}),
    )
}
fn reserve(id: &str, amount: i64) -> Value {
    json!({"op":"workspace_spend_reserve","id":id,"amount":amount,"identity":{"repo_id":"repo","run_id":"run","job_id":"job:run:agent","epoch":1,"request_number":1,"provider":"codex","model":"gpt-5.6-luna","ledger_reservation_id":"model-request:trusted"}})
}
fn settle(id: &str, amount: i64) -> Value {
    let mut c = reserve(id, amount);
    c["op"] = json!("workspace_spend_settle");
    c["input_tokens"] = json!(10);
    c["output_tokens"] = json!(5);
    c
}
#[test]
fn status_is_pure_and_reconciles_historical_totals_without_double_debit() {
    let db = fixture();
    seed(&db, &"a".repeat(64));
    let before = db
        .query("SELECT id,payload FROM workspace_records ORDER BY id", &[])
        .unwrap();
    assert_eq!(
        status(&db),
        json!({"version":0,"limit_microusd":50000000,"charged_microusd":1000,"reserved_microusd":3000,"remaining_microusd":49996000})
    );
    assert_eq!(
        db.query("SELECT id,payload FROM workspace_records ORDER BY id", &[])
            .unwrap(),
        before
    );
}
#[test]
fn ambiguous_historical_identity_never_silently_discards_spend() {
    let db = fixture();
    seed(&db, "manual-collision");
    assert_eq!(
        call(&db, json!({"op":"workspace_spend_status"}))
            .unwrap_err()
            .code,
        "WORKSPACE_SPEND_RECONCILIATION_REQUIRED"
    );
    assert!(configure(&db, 0, 50000000).is_err());
}
#[test]
fn configuration_is_versioned_preserves_history_and_cannot_lower_below_used() {
    let db = fixture();
    seed(&db, &"a".repeat(64));
    assert_eq!(configure(&db, 0, 5000).unwrap()["version"], 1);
    assert_eq!(configure(&db, 0, 5000).unwrap_err().code, "STALE_VERSION");
    assert_eq!(
        configure(&db, 1, 3999).unwrap_err().code,
        "WORKSPACE_SPEND_LIMIT"
    );
    assert_eq!(configure(&db, 1, 6000).unwrap()["version"], 2);
    assert_eq!(status(&db)["charged_microusd"], 1000);
    assert_eq!(status(&db)["reserved_microusd"], 3000);
    assert_eq!(
        call(&db, json!({"op":"budget_status"})).unwrap()["charged"],
        2000
    );
}
#[test]
fn reservations_are_shared_replayed_scope_bound_and_unknown_usage_stays_reserved() {
    let db = fixture();
    assert_eq!(
        call(&db, reserve("first", 700)).unwrap_err().code,
        "WORKSPACE_ALLOWANCE_NOT_CONFIGURED"
    );
    configure(&db, 0, 1000).unwrap();
    call(&db, reserve("first", 700)).unwrap();
    call(&db, reserve("first", 700)).unwrap();
    assert_eq!(status(&db)["reserved_microusd"], 700);
    assert_eq!(
        call(&db, reserve("second", 301)).unwrap_err().code,
        "WORKSPACE_SPEND_EXHAUSTED"
    );
    let mut forged = reserve("first", 700);
    forged["identity"]["run_id"] = json!("other");
    assert_eq!(call(&db, forged).unwrap_err().code, "IDEMPOTENCY_CONFLICT");
    assert_eq!(status(&db)["reserved_microusd"], 700);
}
#[test]
fn settlement_refunds_only_money_once_and_rejects_altered_identity_usage_or_ceiling() {
    let db = fixture();
    configure(&db, 0, 1000).unwrap();
    call(&db, reserve("first", 700)).unwrap();
    assert!(call(&db, settle("first", 701)).is_err());
    let mut forged = settle("first", 100);
    forged["identity"]["provider"] = json!("zai");
    assert_eq!(call(&db, forged).unwrap_err().code, "FORBIDDEN");
    call(&db, settle("first", 100)).unwrap();
    call(&db, settle("first", 100)).unwrap();
    call(&db, reserve("first", 700)).unwrap();
    assert_eq!(
        status(&db),
        json!({"version":1,"limit_microusd":1000,"charged_microusd":100,"reserved_microusd":0,"remaining_microusd":900})
    );
    let mut changed = settle("first", 100);
    changed["output_tokens"] = json!(6);
    assert_eq!(call(&db, changed).unwrap_err().code, "IDEMPOTENCY_CONFLICT");
}
#[test]
fn legacy_activity_after_configuration_is_observed_once_and_fails_new_reserves_closed() {
    let db = fixture();
    configure(&db, 0, 1000).unwrap();
    call(
        &db,
        json!({"op":"budget_reserve","id":"legacy-after","amount":900}),
    )
    .unwrap();
    assert_eq!(status(&db)["reserved_microusd"], 900);
    assert!(call(&db, reserve("adaptive", 101)).is_err());
    call(
        &db,
        json!({"op":"budget_settle","id":"legacy-after","amount":500}),
    )
    .unwrap();
    call(&db, reserve("adaptive", 500)).unwrap();
    assert_eq!(status(&db)["remaining_microusd"], 0);
}
