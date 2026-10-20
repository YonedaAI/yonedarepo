//! A partial guided check cannot be relabelled as final evidence at evaluator completion.
use crate::{commands::source_kit::execute, native::NativeStore, storage::*};
use serde_json::{Value, json};

fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(
        &db,
        json!({"op":"init","id":"guide-checks","name":"Guide checks",
        "remote":{"namespace":"fixture","name":"guide-checks"},"commit":"a".repeat(40),
        "policy":yoneda_agents_core::Policy::default(),"now":1}),
    )
    .unwrap();
    create(&db, "jobs", "evaluate:partial", &json!({
        "id":"evaluate:partial","kind":"evaluate","status":"running","epoch":1,
        "lease_until":10000,"attempt_deadline":10000,"payload":{
            "candidate":{"id":"partial"},"policy":yoneda_agents_core::Policy::default(),
            "guided":{"session_id":"guide-session:checks","profile_id":"task-board-v1","version":1,
                "step_id":"concurrent","check_phase":"parallel","variant":"filter"}
        }
    })).unwrap();
    db
}

#[test]
fn relabelled_missing_and_wrong_variant_reports_leave_the_leased_job_unchanged() {
    for report in [
        json!({"guided_check_phase":"final","guided_check_variant":"filter"}),
        json!({"guided_check_phase":"parallel","guided_check_variant":"sort"}),
        json!({"environment":"rust-1.94.0-evaluator-v2","suite":"retry-contract-v2"}),
    ] {
        let db = fixture();
        let before = get(&db, "jobs", "evaluate:partial").unwrap();
        let error = execute(
            &db,
            json!({"op":"verify_finish","job_id":"evaluate:partial",
            "epoch":1,"now":3,"report":report,"evidence":"b".repeat(64)}),
        )
        .unwrap_err();
        assert_eq!(error.code, "GUIDED_CHECK_MISMATCH");
        assert_eq!(get(&db, "jobs", "evaluate:partial").unwrap(), before);
        assert!(all(&db, "evaluations").unwrap().is_empty());
    }
}

#[test]
fn matching_guide_binding_still_requires_the_original_evaluator_environment() {
    let db = fixture();
    let error = execute(
        &db,
        json!({"op":"verify_finish","job_id":"evaluate:partial",
        "epoch":1,"now":3,"report":{"guided_check_phase":"parallel","guided_check_variant":"filter",
        "environment":"wrong","suite":"retry-contract-v2"},"evidence":"b".repeat(64)}),
    )
    .unwrap_err();
    assert_eq!(error.code, "ENVIRONMENT_MISMATCH");
    assert_eq!(
        get(&db, "jobs", "evaluate:partial").unwrap()["status"],
        Value::String("running".into())
    );
}
