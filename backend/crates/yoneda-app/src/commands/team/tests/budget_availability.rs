use super::*;
use crate::{execute, native::NativeStore};

fn fixture() -> NativeStore {
    let db = autonomous_tests::fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    // Trusted ledger fixture: no provider call or funding operation.
    run["agents"][0] = json!({"provider":"codex","model":"gpt-5.6-luna","strategy":"worker"});
    run["team_plan"]["tasks"][2]["agent"] = json!(1);
    let mut task = get(&db, "team_tasks", "run:task:other").unwrap();
    task["agent"] = json!(1);
    save(&db, "team_tasks", "run:task:other", &task).unwrap();
    run["model_budgets"] = json!([
        {"provider":"codex","model":"gpt-5.6-luna","max_requests":3,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null,"requests":0,"charged_microusd":0},
        {"provider":"zai","model":"glm-5.3-flash","max_requests":3,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null,"requests":0,"charged_microusd":0}
    ]);
    run["autonomy_approval"]["agents"] = run["agents"].clone();
    run["autonomy_approval"]["model_budgets"] = run["model_budgets"].clone();
    run["campaign"] = json!({"id":"campaign","version":1,"chain_id":"chain"});
    run["campaign_approval_digest"] = json!("signed-fixture");
    run["request_limits"] = json!("optional-v1");
    run["status"] = json!("coordinating");
    run["coordinator_execution_id"] = json!("coordinator");
    run["coordination_pending"] = json!(false);
    save(&db, "runs", "run", &run).unwrap();
    let mut job = get(&db, "jobs", "job:coordinator").unwrap();
    job["payload"]["run"] = run;
    save(&db, "jobs", "job:coordinator", &job).unwrap();
    db
}
fn observation() -> Value {
    json!({"op":"observe_campaign_model_limit","_workspace":"_admin","job_id":"job:coordinator","epoch":1,"campaign_id":"campaign","campaign_version":1,"chain_id":"chain","requests":3,"max_requests":3,"now":10})
}
#[test]
fn budget_observation_stops_attempt_and_selects_original_codex_once() {
    let db = fixture();
    let before = get(&db, "runs", "run").unwrap();
    let result = execute(&db, observation()).unwrap();
    assert_eq!(
        get(&db, "jobs", "job:coordinator").unwrap()["status"],
        "failed"
    );
    assert!(
        !db.query("SELECT id FROM outbox WHERE kind='stop'", &[])
            .unwrap()
            .is_empty()
    );
    let run = &result["run"];
    let coordinator = get(
        &db,
        "executions",
        run["coordinator_execution_id"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(coordinator["provider"], "codex");
    assert_eq!(coordinator["team_role"], "coordinator");
    for key in [
        "agents",
        "model_budgets",
        "autonomy_approval",
        "team_repair_rounds",
        "campaign",
    ] {
        assert_eq!(run[key], before[key]);
    }
    let jobs = all(&db, "jobs").unwrap();
    execute(&db, observation()).unwrap();
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    assert_eq!(
        get(&db, "runs", "run").unwrap()["unavailable_model_groups"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn budget_observation_rejects_forged_authority_binding_epoch_and_counts_atomically() {
    for (field, value) in [
        ("_workspace", json!("other")),
        ("campaign_id", json!("other")),
        ("campaign_version", json!(2)),
        ("chain_id", json!("other")),
        ("epoch", json!(2)),
        ("requests", json!(2)),
        ("max_requests", json!(4)),
    ] {
        let db = fixture();
        let before = get(&db, "runs", "run").unwrap();
        let mut c = observation();
        c[field] = value;
        assert!(execute(&db, c).is_err(), "{field}");
        assert_eq!(get(&db, "runs", "run").unwrap(), before);
        assert_eq!(
            get(&db, "jobs", "job:coordinator").unwrap()["status"],
            "running"
        );
    }
    let db = fixture();
    let mut c = observation();
    c.as_object_mut().unwrap().remove("_workspace");
    assert_eq!(execute(&db, c).unwrap_err().code, "FORBIDDEN");
}
#[test]
fn budget_observation_recovers_terminal_current_coordinator_and_all_exhausted_is_terminal() {
    for exhausted in [false, true] {
        let db = fixture();
        execute(&db,json!({"op":"fail","job_id":"job:coordinator","epoch":1,"retryable":false,"now":9,"error":"model quota"})).unwrap();
        if exhausted {
            let mut run = get(&db, "runs", "run").unwrap();
            run["model_budgets"][0]["requests"] = json!(3);
            save(&db, "runs", "run", &run).unwrap();
        }
        let result = execute(&db, observation()).unwrap();
        assert_eq!(
            result["run"]["status"],
            if exhausted { "failed" } else { "coordinating" }
        );
        assert_eq!(result["run"]["coordination_pending"], false);
    }
}
#[test]
fn budget_observation_preserves_intent_pause_and_stops_each_same_group_attempt() {
    let db = fixture();
    execute(&db,json!({"op":"intent_question","job_id":"job:coordinator","epoch":1,"request_id":"q","question":"Which contract?","now":3})).unwrap();
    execute(&db, observation()).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    assert_eq!(run["status"], "awaiting_intent");
    let mut job = get(&db, "jobs", "job:coordinator").unwrap();
    job["id"] = json!("job:another");
    job["status"] = json!("running");
    job["lease_until"] = json!(10000);
    job["payload"]["execution"]["id"] = json!("another");
    job["payload"]["execution"]["team_role"] = json!("worker");
    create(&db, "executions", "another", &job["payload"]["execution"]).unwrap();
    create(&db, "jobs", "job:another", &job).unwrap();
    let mut c = observation();
    c["job_id"] = json!("job:another");
    execute(&db, c).unwrap();
    assert_eq!(get(&db, "jobs", "job:another").unwrap()["status"], "failed");
    assert_eq!(
        get(&db, "runs", "run").unwrap()["status"],
        "awaiting_intent"
    );
    execute(&db,json!({"op":"answer_intent","run_id":"run","question_id":run["intent_question"]["id"],"answer":"Keep contract","now":11})).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    assert_eq!(
        get(
            &db,
            "executions",
            run["coordinator_execution_id"].as_str().unwrap()
        )
        .unwrap()["provider"],
        "codex"
    );
}
#[test]
fn budget_repair_rejects_blocked_integrator_and_accepts_original_available_integrator() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["unavailable_model_groups"] = json!([{"provider":"zai","model":"glm-5.3-flash"}]);
    save(&db, "runs", "run", &run).unwrap();
    assert_eq!(
        repair(&db, &autonomous_tests::request(), 10)
            .unwrap_err()
            .code,
        "MODEL_REQUEST_LIMIT"
    );
    let mut job = get(&db, "jobs", "job:coordinator").unwrap();
    for key in ["provider", "model"] {
        job["payload"]["execution"][key] = run["agents"][0][key].clone();
    }
    job["payload"]["execution"]["budget"] = json!({"provider":"codex","model":"gpt-5.6-luna"});
    save(&db, "jobs", "job:coordinator", &job).unwrap();
    save(
        &db,
        "executions",
        "coordinator",
        &job["payload"]["execution"],
    )
    .unwrap();
    let mut c = autonomous_tests::request();
    c["task_ids"] = json!(["api", "integrate"]);
    repair(&db, &c, 10).unwrap();
    assert_eq!(
        get(&db, "team_tasks", "run:task:integrate").unwrap()["agent"],
        0
    );
    assert_eq!(
        get(&db, "runs", "run").unwrap()["team_plan"]["integrator_agent"],
        0
    );
}

#[test]
fn budget_observation_before_plan_is_terminal_without_rollback_and_cancelled_rejects() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run.as_object_mut().unwrap().remove("team_plan");
    run["status"] = json!("planning");
    save(&db, "runs", "run", &run).unwrap();
    let mut job = get(&db, "jobs", "job:coordinator").unwrap();
    job["payload"]["execution"]["team_role"] = json!("planner");
    save(&db, "jobs", "job:coordinator", &job).unwrap();
    save(
        &db,
        "executions",
        "coordinator",
        &job["payload"]["execution"],
    )
    .unwrap();
    let result = execute(&db, observation()).unwrap();
    assert_eq!(result["run"]["status"], "failed");
    assert_eq!(result["run"]["coordination_pending"], false);
    assert_eq!(
        get(&db, "jobs", "job:coordinator").unwrap()["error"]["code"],
        "CAMPAIGN_MODEL_REQUEST_LIMIT"
    );
    for status in ["cancelled", "accepted"] {
        let db = fixture();
        execute(
            &db,
            json!({"op":"fail","job_id":"job:coordinator","epoch":1,"retryable":false,"now":9}),
        )
        .unwrap();
        let mut run = get(&db, "runs", "run").unwrap();
        run["status"] = json!(status);
        save(&db, "runs", "run", &run).unwrap();
        assert!(execute(&db, observation()).is_err());
        assert_eq!(get(&db, "runs", "run").unwrap(), run);
    }
}
#[test]
fn budget_observation_compare_stops_without_recovery_or_model_swap() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["mode"] = json!("compare");
    run["status"] = json!("exploring");
    save(&db, "runs", "run", &run).unwrap();
    // Isolate one hosted comparison attempt; earlier fixture attempts are terminal.
    for mut e in run_executions(&db, "run").unwrap() {
        if e["id"] != "coordinator" {
            e["status"] = json!("completed");
            save(&db, "executions", e["id"].as_str().unwrap(), &e).unwrap();
        }
    }
    let mut job = get(&db, "jobs", "job:coordinator").unwrap();
    job["payload"]["execution"]["team_role"] = Value::Null;
    save(&db, "jobs", "job:coordinator", &job).unwrap();
    save(
        &db,
        "executions",
        "coordinator",
        &job["payload"]["execution"],
    )
    .unwrap();
    let before = all(&db, "jobs").unwrap().len();
    let result = execute(&db, observation()).unwrap();
    assert_eq!(result["run"]["status"], "failed");
    assert_eq!(result["run"]["coordination_pending"], false);
    assert_eq!(all(&db, "jobs").unwrap().len(), before);
    assert_eq!(
        get(&db, "jobs", "job:coordinator").unwrap()["payload"]["execution"]["provider"],
        "zai"
    );
}
