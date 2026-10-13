use super::*;
use crate::{execute, native::NativeStore};

fn fixture() -> NativeStore {
    let db = autonomous_tests::fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["agents"][0] = json!({"provider":"codex","model":"gpt-5.6-luna","strategy":"worker"});
    run["model_budgets"] = json!([
        {"provider":"codex","model":"gpt-5.6-luna","max_requests":8,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":1000000,"pricing":{"input_microusd_per_million":250000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"},"requests":3,"charged_microusd":1234},
        {"provider":"zai","model":"glm-5.3-flash","max_requests":8,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":1000000,"pricing":{"input_microusd_per_million":800000,"output_microusd_per_million":3600000,"source":"owner-approved conservative rates"},"requests":8,"charged_microusd":5678}
    ]);
    run["autonomy_approval"]["agents"] = run["agents"].clone();
    run["autonomy_approval"]["model_budgets"] = run["model_budgets"].clone();
    run["campaign"] = json!({"id":"original","version":1,"chain_id":"retained","bucket":"routine","purpose":"routine"});
    run["campaign_approval_digest"] = json!("original signed fixture");
    run["unavailable_model_groups"] = json!([{"provider":"zai","model":"glm-5.3-flash"}]);
    run["coordinator_execution_id"] = json!("coordinator");
    run["status"] = json!("failed");
    run["coordination_pending"] = json!(false);
    run["execution_count"] = json!(run_executions(&db, "run").unwrap().len());
    save(&db, "runs", "run", &run).unwrap();
    for mut job in run_jobs(&db, "run").unwrap() {
        job["status"] = json!("done");
        if job["id"] == "job:coordinator" {
            job["payload"]["run"] = run.clone();
            job["payload"]["execution"]["status"] = json!("completed");
            let mut execution = get(&db, "executions", "coordinator").unwrap();
            execution["status"] = json!("completed");
            save(&db, "executions", "coordinator", &execution).unwrap();
        }
        save(&db, "jobs", job["id"].as_str().unwrap(), &job).unwrap();
    }
    let mut task = get(&db, "team_tasks", "run:task:integrate").unwrap();
    task["status"] = json!("failed");
    save(&db, "team_tasks", "run:task:integrate", &task).unwrap();
    db
}
fn request() -> Value {
    json!({"op":"retry_coordinator","_workspace":"_admin","run_id":"run","request_id":"runtime-recovery",
        "expected_coordinator_job":"job:coordinator","expected_epoch":1,"expected_commit":"a".repeat(40),
        "expected_version":0,"expected_plan_revision":1,"now":10})
}
#[test]
fn owner_coordinator_retry_is_once_replayed_and_keeps_original_approvals_and_charges() {
    let db = fixture();
    let before = get(&db, "runs", "run").unwrap();
    let result = execute(&db, request()).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    assert_eq!(run["status"], "coordinating");
    assert_eq!(
        number(&run, "execution_count").unwrap(),
        number(&before, "execution_count").unwrap() + 1
    );
    for key in [
        "campaign",
        "campaign_approval_digest",
        "autonomy_approval",
        "autonomy_policy",
        "agents",
        "model_budgets",
        "team_plan",
        "team_plan_revision",
        "team_repair_rounds",
        "base",
    ] {
        assert_eq!(run[key], before[key], "{key}");
    }
    let coordinator = get(&db, "executions", result["execution_id"].as_str().unwrap()).unwrap();
    assert_eq!(coordinator["model"], "gpt-5.6-luna");
    let jobs = all(&db, "jobs").unwrap();
    assert_eq!(execute(&db, request()).unwrap(), result);
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    let mut different = request();
    different["request_id"] = json!("another");
    assert_eq!(
        execute(&db, different).unwrap_err().code,
        "COORDINATION_RETRY_EXHAUSTED"
    );
    let mut changed = request();
    changed["expected_epoch"] = json!(2);
    assert_eq!(
        execute(&db, changed).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
}
#[test]
fn owner_coordinator_retry_rejects_authority_and_stale_guards_without_mutation() {
    for (key, value) in [
        ("_workspace", json!("other")),
        ("_grant", json!("agent")),
        ("job_id", json!("job:coordinator")),
        ("expected_epoch", json!(2)),
        ("expected_coordinator_job", json!("job:other")),
        ("expected_commit", json!("b".repeat(40))),
        ("expected_version", json!(1)),
        ("expected_plan_revision", json!(2)),
    ] {
        let db = fixture();
        let before = get(&db, "runs", "run").unwrap();
        let mut c = request();
        c[key] = value;
        assert!(execute(&db, c).is_err(), "{key}");
        assert_eq!(get(&db, "runs", "run").unwrap(), before, "{key}");
    }
}
#[test]
fn owner_coordinator_retry_denies_pending_intent_running_work_and_exhausted_envelopes() {
    for (key, value) in [
        ("status", json!("accepted")),
        ("status", json!("cancelled")),
        ("intent_question", json!({"status":"pending","id":"q"})),
        ("team_repair_rounds", json!(2)),
        (
            "unavailable_model_groups",
            json!([{"provider":"codex","model":"gpt-5.6-luna"},{"provider":"zai","model":"glm-5.3-flash"}]),
        ),
    ] {
        let db = fixture();
        let mut run = get(&db, "runs", "run").unwrap();
        run[key] = value;
        save(&db, "runs", "run", &run).unwrap();
        assert!(execute(&db, request()).is_err(), "{key}");
        assert_eq!(get(&db, "runs", "run").unwrap(), run, "{key}");
    }
    let db = fixture();
    let mut job = get(&db, "jobs", "job:coordinator").unwrap();
    job["status"] = json!("running");
    save(&db, "jobs", "job:coordinator", &job).unwrap();
    assert!(execute(&db, request()).is_err());
}

#[test]
fn owner_retry_uses_trusted_shared_exhaustion_without_resetting_local_counters() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["unavailable_model_groups"] = json!([]);
    run["model_budgets"][1]["requests"] = json!(0);
    save(&db, "runs", "run", &run).unwrap();
    let mut c = request();
    c["_shared_model_limits"] = json!([{"provider":"zai","model":"glm-5.3-flash","requests":8,
        "max_requests":8,"charged_microusd":5678,"spend_limit_microusd":1000000}]);
    let result = execute(&db, c).unwrap();
    let next = get(&db, "executions", result["execution_id"].as_str().unwrap()).unwrap();
    assert_eq!(next["model"], "gpt-5.6-luna");
    let after = get(&db, "runs", "run").unwrap();
    assert_eq!(after["model_budgets"], run["model_budgets"]);
    assert_eq!(after["autonomy_approval"], run["autonomy_approval"]);
    assert_eq!(
        after["unavailable_model_groups"][0]["model"],
        "glm-5.3-flash"
    );
}

#[test]
fn owner_retry_rejects_invalid_shared_observations_atomically() {
    for (key, value) in [
        ("provider", json!("claude")),
        ("max_requests", json!(99)),
        ("requests", json!(7)),
        ("charged_microusd", json!(-1)),
        ("spend_limit_microusd", json!(2000000)),
    ] {
        let db = fixture();
        let before = get(&db, "runs", "run").unwrap();
        let jobs = all(&db, "jobs").unwrap();
        let mut observation = json!({"provider":"zai","model":"glm-5.3-flash","requests":8,
            "max_requests":8,"charged_microusd":5678,"spend_limit_microusd":1000000});
        observation[key] = value;
        let mut c = request();
        c["_shared_model_limits"] = json!([observation]);
        assert!(execute(&db, c).is_err(), "{key}");
        assert_eq!(get(&db, "runs", "run").unwrap(), before);
        assert_eq!(all(&db, "jobs").unwrap(), jobs);
    }
}

#[test]
fn owner_retry_cannot_exceed_execution_cap_or_change_protected_policy() {
    let db = fixture();
    for index in run_executions(&db, "run").unwrap().len()..20 {
        let id = format!("previous-{index}");
        create(
            &db,
            "executions",
            &id,
            &json!({"id":id,"run_id":"run","status":"completed"}),
        )
        .unwrap();
    }
    let before = get(&db, "runs", "run").unwrap();
    assert_eq!(
        execute(&db, request()).unwrap_err().code,
        "REPAIR_BUDGET_EXHAUSTED"
    );
    assert_eq!(get(&db, "runs", "run").unwrap(), before);
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["policy"]["version"] = json!("unapproved");
    save(&db, "runs", "run", &run).unwrap();
    assert_eq!(execute(&db, request()).unwrap_err().code, "FORBIDDEN");
    assert_eq!(get(&db, "runs", "run").unwrap(), run);
}
