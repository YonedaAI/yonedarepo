use crate::{SqlStore, execute_workspace, native::NativeStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut c: Value) -> yoneda_agents_core::Result<Value> {
    c["now"] = json!(1000);
    execute_workspace(db, c)
}
fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"signup","username":"transition_owner","password":"synthetic local password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    call(
        &db,
        json!({"op":"reviewer_configure","repo_id":"legacy_repo","expires":50000}),
    )
    .unwrap();
    let approval = json!({"version":1,"audience":"owner","repo_ids":["legacy_repo"],"expires":50000,"limit_microusd":50000,"chain_limit_microusd":10000,"buckets":{"routine":30000,"opus":10000,"reserve":10000},"model_budgets":[{"provider":"codex","model":"gpt-5.6-luna","max_requests":3,"max_output_tokens":256,"max_execution_ms":60000,"spend_limit_microusd":10000,"pricing":{"input_microusd_per_million":250000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"}}]});
    call(&db,json!({"op":"campaign_configure","id":"legacy_campaign","expected_version":0,"approval":approval})).unwrap();
    call(&db,json!({"op":"campaign_enable","id":"legacy_campaign","expected_version":1,"expected_revision":1,"local_gate_receipt":"synthetic local gate"})).unwrap();
    db
}
fn configure() -> Value {
    json!({"op":"workspace_spend_configure","expected_version":0,"limit_microusd":50000000})
}
fn campaign_trial() -> Value {
    json!({"op":"campaign_trial","id":"legacy_campaign","repo_id":"legacy_repo","run_id":"paused_campaign","run_request":{"id":"paused_campaign","campaign":{"id":"legacy_campaign","version":1},"working_branch_id":"campaign-development","mode":"collaborate","autonomy_policy":{"enabled":true}}})
}
fn snapshot(db: &NativeStore) -> Value {
    json!({"records":db.query("SELECT id,payload FROM workspace_records ORDER BY id", &[]).unwrap(),"events":db.query("SELECT kind,at,data FROM workspace_events ORDER BY rowid", &[]).unwrap()})
}

#[test]
fn allocated_reviewer_trial_fences_configuration_before_repository_start() {
    let db = fixture();
    call(&db, json!({"op":"reviewer_trial","id":"paused_reviewer"})).unwrap();
    let before = snapshot(&db);
    assert_eq!(
        call(&db, configure()).unwrap_err().code,
        "WORKSPACE_TRANSITION_BUSY"
    );
    assert_eq!(snapshot(&db), before);
    assert_eq!(
        call(&db, json!({"op":"workspace_spend_status"})).unwrap()["version"],
        0
    );
    assert_eq!(
        call(&db, json!({"op":"reviewer_status"})).unwrap()["active_trial"],
        "paused_reviewer"
    );
}

#[test]
fn allocated_campaign_trial_fences_configuration_before_repository_start() {
    let db = fixture();
    call(&db, campaign_trial()).unwrap();
    let before = snapshot(&db);
    assert_eq!(
        call(&db, configure()).unwrap_err().code,
        "WORKSPACE_TRANSITION_BUSY"
    );
    assert_eq!(snapshot(&db), before);
    assert_eq!(
        call(&db, json!({"op":"campaign_status","id":"legacy_campaign"})).unwrap()["active_trial"],
        "paused_campaign"
    );
}

#[test]
fn configuration_fences_later_legacy_allocations_atomically_without_changing_approvals() {
    let db = fixture();
    call(&db, configure()).unwrap();
    let before = snapshot(&db);
    for c in [
        json!({"op":"reviewer_trial","id":"late_reviewer"}),
        campaign_trial(),
    ] {
        assert_eq!(
            call(&db, c).unwrap_err().code,
            "WORKSPACE_LEGACY_INFERENCE_BLOCKED"
        );
        assert_eq!(snapshot(&db), before);
    }
}

#[test]
fn completed_legacy_receipts_remain_readable_but_cannot_reopen_or_restart_after_transition() {
    let db = fixture();
    call(&db, json!({"op":"reviewer_trial","id":"old_complete"})).unwrap();
    call(
        &db,
        json!({"op":"reviewer_trial_complete","id":"old_complete","expected_epoch":1}),
    )
    .unwrap();
    call(&db, campaign_trial()).unwrap();
    call(
        &db,
        json!({"op":"campaign_trial_complete","id":"legacy_campaign","run_id":"paused_campaign"}),
    )
    .unwrap();
    call(&db, configure()).unwrap();
    let before = snapshot(&db);
    for c in [
        json!({"op":"reviewer_trial","id":"old_complete"}),
        json!({"op":"reviewer_trial_reopen","id":"old_complete","request_id":"synthetic-repair-id","fingerprint":"f".repeat(64)}),
        campaign_trial(),
    ] {
        assert_eq!(
            call(&db, c).unwrap_err().code,
            "WORKSPACE_LEGACY_INFERENCE_BLOCKED"
        );
        assert_eq!(snapshot(&db), before);
    }
    assert_eq!(
        call(
            &db,
            json!({"op":"campaign_trial_status","id":"legacy_campaign","run_id":"paused_campaign"})
        )
        .unwrap()["status"],
        "complete"
    );
}
