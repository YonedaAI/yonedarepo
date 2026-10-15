//! Stale checked-head boundary, using actual Native capture command fixtures.
use super::*;
fn autonomous() -> Value {
    let mut input = prepared();
    input["model_budgets"] = json!([{"provider":"zai","model":"glm-5.3-flash","max_requests":48,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":5000000,"pricing":{"input_microusd_per_million":1000000,"output_microusd_per_million":2000000,"source":"owner-approved conservative rates"}}]);
    input["autonomy_policy"] = json!({"version":1,"enabled":true,"max_repair_rounds":2,"max_concurrent_agents":3,"max_executions":20,"source_scope":"project","allow_intent_questions":true});
    input
}
fn stale_capture() -> (NativeStore, Value, Value) {
    let (db, view) = through_extend();
    let mut c = request("concurrent");
    c["expected_commit"] = view["working_revision"]["commit"].clone();
    c["expected_version"] = view["working_version"].clone();
    c["_guided_runs"] = json!([autonomous(), autonomous()]);
    let started = execute(&db, c).unwrap();
    let ids = started["steps"][2]["run_ids"].as_array().unwrap();
    evidence_fixture::checked(&db, ids[0].as_str().unwrap(), "parallel", true);
    let cid = evidence_fixture::captured_with_context(&db, ids[1].as_str().unwrap(), true, None);
    let run = get(&db, "runs", ids[1].as_str().unwrap()).unwrap();
    let mut candidate = get(&db, "candidates", &cid).unwrap();
    // Supply the independent checker outcome to the promotion boundary under test.
    // This does not claim a hosted source check or completed guide session.
    candidate["status"] = json!("eligible");
    (db, run, candidate)
}
#[test]
fn guided_stale_promote_wakes_one_original_coordinator_and_preserves_frozen_approval() {
    let (db, mut run, mut candidate) = stale_capture();
    let original = run.clone();
    crate::commands::branches::promote(&db, &mut run, &mut candidate, 60).unwrap();
    assert_eq!(candidate["working_branch_state"], "stale");
    assert!(
        run["coordinator_execution_id"].is_string(),
        "stale promotion must wake coordinator before returning local run"
    );
    let id = run["coordinator_execution_id"].as_str().unwrap().to_owned();
    let job = get(&db, "jobs", &format!("job:{id}")).unwrap();
    assert_eq!(job["status"], "queued");
    assert_eq!(job["payload"]["team_coordination"], true);
    assert_eq!(
        job["payload"]["execution"]["model"],
        original["agents"][1]["model"]
    );
    for key in [
        "autonomy_policy",
        "autonomy_approval",
        "model_budgets",
        "policy",
        "agents",
        "team_repair_rounds",
    ] {
        assert_eq!(run[key], original[key]);
    }
    assert_eq!(
        run["execution_count"].as_i64(),
        Some(original["execution_count"].as_i64().unwrap() + 1)
    );
    let jobs = all(&db, "jobs").unwrap();
    save(&db, "runs", run["id"].as_str().unwrap(), &run).unwrap();
    crate::commands::team::evaluated(&db, &run, &candidate, true, 61).unwrap();
    crate::commands::branches::promote(&db, &mut run, &mut candidate, 62).unwrap();
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    assert_eq!(run["coordinator_execution_id"], id);
    assert_eq!(run["coordination_pending"], false);
}
#[test]
fn guided_stale_promotion_with_exhausted_original_group_does_not_allocate_or_reset() {
    let (db, mut run, mut candidate) = stale_capture();
    run["model_budgets"][0]["requests"] = run["model_budgets"][0]["max_requests"].clone();
    save(&db, "runs", run["id"].as_str().unwrap(), &run).unwrap();
    let budgets = run["model_budgets"].clone();
    let jobs = all(&db, "jobs").unwrap();
    crate::commands::branches::promote(&db, &mut run, &mut candidate, 60).unwrap();
    assert_eq!(run["status"], "failed");
    assert_eq!(run["model_budgets"], budgets);
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    assert!(run["coordinator_execution_id"].is_null());
}

#[path = "guided_resolution_tests.rs"]
mod resolution;

#[test]
fn guided_stale_evaluation_completion_retains_queued_coordinator_state() {
    let (db, original, candidate) = stale_capture();
    evidence_fixture::evaluate(&db, candidate["id"].as_str().unwrap(), "parallel");
    let run = get(&db, "runs", original["id"].as_str().unwrap()).unwrap();
    assert_eq!(run["status"], "coordinating");
    assert_eq!(run["coordination_pending"], false);
    assert_eq!(
        run["execution_count"].as_i64(),
        Some(original["execution_count"].as_i64().unwrap() + 1)
    );
    let id = run["coordinator_execution_id"].as_str().unwrap();
    assert_eq!(
        get(&db, "jobs", &format!("job:{id}")).unwrap()["status"],
        "queued"
    );
    assert_eq!(run["model_budgets"], original["model_budgets"]);
}

#[path = "guided_resolver_scope_tests.rs"]
mod resolver_scope;
