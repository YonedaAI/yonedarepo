use crate::{SqlStore, execute_workspace, native::NativeStore};
use serde_json::{Value, json};
fn call(db: &NativeStore, mut c: Value) -> yoneda_core::Result<Value> {
    c["now"] = json!(1000);
    execute_workspace(db, c)
}
fn budget() -> Value {
    json!({"provider":"codex","model":"gpt-5.6-luna","max_requests":3,"max_output_tokens":256,"max_execution_ms":60000,"spend_limit_microusd":10000,"pricing":{"input_microusd_per_million":1000000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"}})
}
fn approval() -> Value {
    json!({"version":1,"audience":"owner","repo_ids":["booking"],"expires":50000,"limit_microusd":30000,"chain_limit_microusd":10000,"buckets":{"routine":20000,"opus":5000,"reserve":5000},"model_budgets":[budget()]})
}
fn setup() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"signup","username":"campaign_owner","password":"private synthetic password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    call(
        &db,
        json!({"op":"budget_reserve","id":"legacy","amount":1234}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"campaign_configure","id":"fresh","expected_version":0,"approval":approval()}),
    )
    .unwrap();
    call(&db,json!({"op":"campaign_enable","id":"fresh","expected_version":1,"expected_revision":1,"local_gate_receipt":"synthetic local gate"})).unwrap();
    db
}
fn bind(db: &NativeStore, run: &str, chain: &str) -> Value {
    let c = json!({"op":"campaign_bind_run","id":"fresh","version":1,"repo_id":"booking","run_id":run,"chain_id":chain,"bucket":"routine","purpose":"routine","model_budgets":[budget()]});
    call(db, c.clone()).unwrap();
    c
}
fn reserve(run: &str, id: &str) -> Value {
    json!({"op":"campaign_reserve","repo_id":"booking","run_id":run,"reservation_id":id,"provider":"codex","model":"gpt-5.6-luna","input_bytes":0,"output_tokens":256,"count_only":false,"amount":8500})
}
#[test]
fn campaign_ceilings_replay_and_stage_chains_are_atomic() {
    let db = setup();
    bind(&db, "initial", "chain1");
    bind(&db, "feature", "chain1");
    bind(&db, "bugfix", "chain2");
    let first = reserve("initial", "one");
    let receipt = call(&db, first.clone()).unwrap();
    assert_eq!(call(&db, first.clone()).unwrap(), receipt);
    assert_eq!(
        call(&db, reserve("feature", "two")).unwrap_err().code,
        "CAMPAIGN_EXHAUSTED"
    );
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap()["charged_microusd"],
        8500
    );
    call(&db, reserve("bugfix", "three")).unwrap();
    bind(&db, "other", "chain3");
    assert_eq!(
        call(&db, reserve("other", "four")).unwrap_err().code,
        "CAMPAIGN_EXHAUSTED"
    );
    let before = call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap();
    let mut altered = first;
    altered["amount"] = json!(-1);
    assert!(call(&db, altered).is_err());
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap(),
        before
    );
    assert_eq!(
        call(&db, json!({"op":"budget_status"})).unwrap()["charged"],
        1234
    );
}
#[test]
fn campaign_settlement_is_immutable_and_survives_disable() {
    let db = setup();
    bind(&db, "initial", "chain1");
    call(&db, reserve("initial", "one")).unwrap();
    call(
        &db,
        json!({"op":"campaign_disable","id":"fresh","expected_version":1,"expected_revision":2}),
    )
    .unwrap();
    assert_eq!(
        call(&db, reserve("initial", "new")).unwrap_err().code,
        "CAMPAIGN_DISABLED"
    );
    let settled = json!({"op":"campaign_settle","repo_id":"booking","run_id":"initial","reservation_id":"one","provider":"codex","model":"gpt-5.6-luna","input_tokens":100,"output_tokens":10});
    let receipt = call(&db, settled.clone()).unwrap();
    assert_eq!(receipt["charged_microusd"], 112);
    assert_eq!(call(&db, settled.clone()).unwrap(), receipt);
    let mut altered = settled;
    altered["input_tokens"] = json!(101);
    assert_eq!(call(&db, altered).unwrap_err().code, "IDEMPOTENCY_CONFLICT");
    let mut next = approval();
    next["version"] = json!(2);
    call(
        &db,
        json!({"op":"campaign_configure","id":"fresh","expected_version":1,"approval":next}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap()["charged_microusd"],
        112
    );
    let persisted = db
        .query(
            "SELECT payload FROM workspace_records WHERE id='campaign:fresh:approval:1'",
            &[],
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(persisted[0]["payload"].as_str().unwrap()).unwrap(),
        approval()
    );
}

#[test]
fn request_exhaustion_is_distinct_from_financial_exhaustion_and_never_refunds_counts() {
    let db = setup();
    bind(&db, "initial", "chain1");
    for id in ["one", "two", "three"] {
        call(&db, reserve("initial", id)).unwrap();
        call(&db, json!({"op":"campaign_settle","repo_id":"booking","run_id":"initial","reservation_id":id,"provider":"codex","model":"gpt-5.6-luna","input_tokens":100,"output_tokens":10})).unwrap();
    }
    bind(&db, "feature", "chain1");
    let before = call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap();
    assert_eq!(
        call(&db, reserve("feature", "four")).unwrap_err().code,
        "CAMPAIGN_MODEL_REQUEST_LIMIT"
    );
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap(),
        before
    );
    assert_eq!(
        before["chains"][0]["models"]["codex/gpt-5.6-luna"]["requests"],
        3
    );
}
#[test]
fn campaign_binding_cannot_switch_old_runs_or_fund_reserve() {
    let db = setup();
    let c = bind(&db, "initial", "chain1");
    assert_eq!(call(&db, c.clone()).unwrap()["chain_id"], "chain1");
    let mut swapped = c.clone();
    swapped["chain_id"] = json!("chain2");
    assert_eq!(call(&db, swapped).unwrap_err().code, "IDEMPOTENCY_CONFLICT");
    let mut reserve = c;
    reserve["run_id"] = json!("reserve");
    reserve["bucket"] = json!("reserve");
    assert_eq!(call(&db, reserve).unwrap_err().code, "FORBIDDEN");
    let mut increased = approval();
    increased["version"] = json!(2);
    increased["expires"] = json!(60000);
    call(
        &db,
        json!({"op":"campaign_disable","id":"fresh","expected_version":1,"expected_revision":2}),
    )
    .unwrap();
    assert_eq!(call(&db,json!({"op":"campaign_configure","id":"fresh","expected_version":1,"approval":increased})).unwrap_err().code,"IDEMPOTENCY_CONFLICT");
}
#[test]
fn reviewer_coding_plan_and_unpriced_configuration_fail_closed() {
    let db = setup();
    let mut value = approval();
    value["audience"] = json!("reviewer");
    value["model_budgets"][0]["provider"] = json!("zai");
    value["model_budgets"][0]["model"] = json!("glm-5.3-flash");
    assert_eq!(
        call(
            &db,
            json!({"op":"campaign_configure","id":"reviewer","expected_version":0,"approval":value})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    let mut unpriced = approval();
    unpriced["model_budgets"][0]["pricing"] = Value::Null;
    assert!(call(&db,json!({"op":"campaign_configure","id":"unpriced","expected_version":0,"approval":unpriced})).is_err());
}

#[test]
fn campaign_next_version_changes_repos_without_resetting_spend_or_chain_authority() {
    let db = setup();
    let old_binding = bind(&db, "initial", "chain1");
    let reservation = call(&db, reserve("initial", "pending")).unwrap();
    call(
        &db,
        json!({"op":"campaign_disable","id":"fresh","expected_version":1,"expected_revision":2}),
    )
    .unwrap();
    let before = call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap();
    let mut next = approval();
    next["version"] = json!(2);
    next["repo_ids"] = json!(["booking-fresh"]);
    call(
        &db,
        json!({"op":"campaign_configure","id":"fresh","expected_version":1,"approval":next}),
    )
    .unwrap();
    let after = call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap();
    assert_eq!(after["charged_microusd"], 8500);
    assert_eq!(after["charged"], before["charged"]);
    assert_eq!(after["chains"], before["chains"]);
    assert_eq!(after["approval"], next);
    let prior = db
        .query(
            "SELECT payload FROM workspace_records WHERE id='campaign:fresh:approval:1'",
            &[],
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(prior[0]["payload"].as_str().unwrap()).unwrap(),
        approval()
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"campaign_run_status","repo_id":"booking","run_id":"initial"})
        )
        .unwrap(),
        {
            let mut expected = old_binding.clone();
            expected.as_object_mut().unwrap().remove("op");
            expected["repair_escalation"] = Value::Null;
            expected["access"] = json!("owner");
            expected
        }
    );
    assert_eq!(
        call(&db, reserve("initial", "pending")).unwrap_err().code,
        "CAMPAIGN_DISABLED"
    );
    call(&db, json!({"op":"campaign_enable","id":"fresh","expected_version":2,"expected_revision":4,"local_gate_receipt":"synthetic upgrade gate"})).unwrap();
    assert_eq!(
        call(&db, reserve("initial", "pending")).unwrap(),
        reservation
    );
    let mut removed_scope = old_binding.clone();
    removed_scope["version"] = json!(2);
    removed_scope["run_id"] = json!("unauthorized-old-repo");
    assert_eq!(call(&db, removed_scope).unwrap_err().code, "FORBIDDEN");
    let mut fresh_binding = json!({"op":"campaign_bind_run","id":"fresh","version":2,"repo_id":"booking-fresh","run_id":"replacement","chain_id":"chain1","bucket":"routine","purpose":"routine","model_budgets":[budget()]});
    call(&db, fresh_binding.clone()).unwrap();
    let mut fresh_reservation = reserve("replacement", "next");
    fresh_reservation["repo_id"] = json!("booking-fresh");
    assert_eq!(
        call(&db, fresh_reservation.clone()).unwrap_err().code,
        "CAMPAIGN_EXHAUSTED"
    );
    fresh_binding["run_id"] = json!("new-chain");
    fresh_binding["chain_id"] = json!("chain2");
    call(&db, fresh_binding.clone()).unwrap();
    fresh_reservation["run_id"] = json!("new-chain");
    call(&db, fresh_reservation.clone()).unwrap();
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap()["charged_microusd"],
        17000
    );
    fresh_binding["run_id"] = json!("over-bucket");
    fresh_binding["chain_id"] = json!("chain3");
    call(&db, fresh_binding).unwrap();
    fresh_reservation["run_id"] = json!("over-bucket");
    fresh_reservation["reservation_id"] = json!("third");
    let before_rejection = call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap();
    assert_eq!(
        call(&db, fresh_reservation).unwrap_err().code,
        "CAMPAIGN_EXHAUSTED"
    );
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap(),
        before_rejection
    );
    call(
        &db,
        json!({"op":"campaign_configure","id":"fresh","expected_version":1,"approval":next}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap(),
        before_rejection
    );
    let mut forged = next;
    forged["repo_ids"] = json!(["foreign"]);
    assert_eq!(
        call(
            &db,
            json!({"op":"campaign_configure","id":"fresh","expected_version":1,"approval":forged})
        )
        .unwrap_err()
        .code,
        "IDEMPOTENCY_CONFLICT"
    );
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"fresh"})).unwrap(),
        before_rejection
    );
    call(
        &db,
        json!({"op":"campaign_disable","id":"fresh","expected_version":2,"expected_revision":5}),
    )
    .unwrap();
    forged["version"] = json!(3);
    forged["limit_microusd"] = json!(40000);
    forged["buckets"]["routine"] = json!(30000);
    assert_eq!(
        call(
            &db,
            json!({"op":"campaign_configure","id":"fresh","expected_version":2,"approval":forged})
        )
        .unwrap_err()
        .code,
        "IDEMPOTENCY_CONFLICT"
    );
    assert_eq!(
        call(&db, json!({"op":"budget_status"})).unwrap()["charged"],
        1234
    );
}
