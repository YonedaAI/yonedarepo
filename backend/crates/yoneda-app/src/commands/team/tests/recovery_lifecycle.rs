use super::autonomous_tests::{conflict, fixture, request, resolver_request};
use super::*;
use crate::commands::source_kit::execute;

#[test]
fn terminal_coordinator_failure_reconciles_run_without_consuming_repair_or_budget() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["status"] = json!("coordinating");
    run["coordinator_execution_id"] = json!("coordinator");
    run["coordination_pending"] = json!(false);
    save(&db, "runs", "run", &run).unwrap();
    execute(&db,json!({"op":"fail","job_id":"job:coordinator","epoch":1,"retryable":false,"error":"Native fixture: approved coordinator allowance exhausted","now":10})).unwrap();
    assert_eq!(
        get(&db, "jobs", "job:coordinator").unwrap()["status"],
        "failed"
    );
    assert_eq!(
        get(&db, "executions", "coordinator").unwrap()["status"],
        "failed"
    );
    let failed = get(&db, "runs", "run").unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["model_budgets"], run["model_budgets"]);
    assert_eq!(failed["team_repair_rounds"], run["team_repair_rounds"]);
}

#[test]
fn terminal_coordinator_failure_preserves_pending_intent_and_owner_can_answer() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["status"] = json!("coordinating");
    run["coordinator_execution_id"] = json!("coordinator");
    save(&db, "runs", "run", &run).unwrap();
    let question=execute(&db,json!({"op":"intent_question","job_id":"job:coordinator","epoch":1,"request_id":"failure-pending","question":"Include archived source?","now":10})).unwrap();
    execute(&db,json!({"op":"fail","job_id":"job:coordinator","epoch":1,"retryable":false,"error":"Native fixture: coordinator terminal failure","now":11})).unwrap();
    assert_eq!(
        get(&db, "runs", "run").unwrap()["status"],
        "awaiting_intent"
    );
    assert_eq!(
        get(&db, "intent_questions", question["id"].as_str().unwrap()).unwrap()["status"],
        "pending"
    );
    execute(&db,json!({"op":"answer_intent","run_id":"run","question_id":question["id"],"answer":"Active only","now":12})).unwrap();
    assert_eq!(
        get(&db, "runs", "run").unwrap()["intent_clarifications"][0]["answer"],
        "Active only"
    );
    assert_eq!(
        get(&db, "runs", "run").unwrap()["team_repair_rounds"],
        run["team_repair_rounds"]
    );
}

#[test]
fn dag_and_resolver_share_two_rounds_and_final_round_replay_does_not_spend_again() {
    let db = fixture();
    conflict(&db);
    repair(&db, &request(), 10).unwrap();
    let mut resolver = resolver_request();
    resolver["expected_plan_revision"] = json!(2);
    resolver["expected_task_revisions"] = json!({"api":2,"integrate":2});
    let receipt = execute(&db, resolver.clone()).unwrap();
    assert_eq!(get(&db, "runs", "run").unwrap()["team_repair_rounds"], 2);
    assert_eq!(execute(&db, resolver).unwrap(), receipt);
    assert_eq!(get(&db, "runs", "run").unwrap()["team_repair_rounds"], 2);
    let mut third = request();
    third["request_id"] = json!("third");
    third["expected_plan_revision"] = json!(2);
    third["expected_task_revisions"] = json!({"api":2,"ui":2,"integrate":2});
    assert_eq!(
        repair(&db, &third, 20).unwrap_err().code,
        "REPAIR_BUDGET_EXHAUSTED"
    );
}

#[test]
fn plan_can_add_a_needed_task_without_touching_independent_work() {
    let db = fixture();
    let untouched = get(&db, "team_tasks", "run:task:other").unwrap();
    let mut c = request();
    c["task_ids"] = json!(["new-adapter"]);
    c["expected_task_revisions"] = json!({"integrate":1});
    c["task_definitions"] = json!([{"id":"new-adapter","title":"Adapter","instructions":"Connect search contracts","agent":0,"depends_on":["api"],"write_paths":["src/adapter.rs"]}]);
    repair(&db, &c, 10).unwrap();
    let task = get(&db, "team_tasks", "run:task:new-adapter").unwrap();
    assert_eq!(task["revision"], 1);
    assert_eq!(task["depends_on"], json!(["api"]));
    assert_eq!(get(&db, "team_tasks", "run:task:other").unwrap(), untouched);
    assert!(
        get(&db, "team_tasks", "run:task:integrate").unwrap()["depends_on"]
            .as_array()
            .unwrap()
            .contains(&json!("new-adapter"))
    );
}

#[test]
fn new_failure_signal_reuses_an_active_coordinator_and_does_not_replace_its_authority() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["coordinator_execution_id"] = json!("coordinator");
    run["coordination_pending"] = json!(true);
    save(&db, "runs", "run", &run).unwrap();
    super::super::coordination::maybe_start(&db, &run, 10).unwrap();
    assert_eq!(
        get(&db, "runs", "run").unwrap()["coordinator_execution_id"],
        "coordinator"
    );
    assert!(get(&db, "jobs", "job:run:coordinator:1:0:0").is_err());
}

#[test]
fn coordinator_finishes_read_only_while_question_waits_and_answer_resumes_fresh_context() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["coordinator_execution_id"] = json!("coordinator");
    run["status"] = json!("coordinating");
    save(&db, "runs", "run", &run).unwrap();
    let question = execute(&db,json!({"op":"intent_question","job_id":"job:coordinator","epoch":1,"request_id":"ambiguity","question":"Should search include archived source?","options":["Active only","Include archives"],"now":10})).unwrap();
    assert_eq!(execute(&db,json!({"op":"intent_question","job_id":"job:coordinator","epoch":1,"request_id":"ambiguity","question":"Should search include archived source?","options":["Active only","Include archives"],"now":10})).unwrap(),question);
    execute(&db,json!({"op":"finish","job_id":"job:coordinator","epoch":1,"result":{"planning":true,"source_unchanged":true},"now":11})).unwrap();
    assert_eq!(
        get(&db, "runs", "run").unwrap()["status"],
        "awaiting_intent"
    );
    assert!(
        !all(&db, "jobs")
            .unwrap()
            .iter()
            .any(|j| j["kind"] == "capture")
    );
    execute(&db,json!({"op":"answer_intent","run_id":"run","question_id":question["id"],"answer":"Active only","now":12})).unwrap();
    let job = get(&db, "jobs", "job:run:coordinator:1:0:1").unwrap();
    assert_eq!(
        job["payload"]["run"]["intent_clarifications"][0]["answer"],
        "Active only"
    );
    assert_eq!(job["payload"]["run"]["intent"], run["intent"]);
    assert_eq!(
        get(&db, "runs", "run").unwrap()["team_repair_rounds"],
        Value::Null
    );
}

#[test]
fn resolver_capture_cannot_create_candidate_after_plan_superseded() {
    let db = fixture();
    conflict(&db);
    let receipt = execute(&db, resolver_request()).unwrap();
    let execution_id = receipt["execution_id"].as_str().unwrap();
    let execution = get(&db, "executions", execution_id).unwrap();
    let job_id = format!("capture:{execution_id}");
    create(&db,"jobs",&job_id,&json!({"id":job_id,"kind":"capture","status":"running","epoch":1,"lease_until":1000,"attempt_deadline":1000,"payload":{"capture_subtype":"source_changeset","source_resolution":true,"conflict_id":"conflict","execution":execution}})).unwrap();
    let mut run = get(&db, "runs", "run").unwrap();
    run["team_plan_revision"] = json!(2);
    save(&db, "runs", "run", &run).unwrap();
    assert_eq!(
        execute(
            &db,
            json!({"op":"finish","job_id":job_id,"epoch":1,"now":20,"result":{"id":"late"}})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    assert!(get(&db, "candidates", "late").is_err());
}

#[test]
fn dag_repair_fences_a_running_resolver_descended_from_integration() {
    let db = fixture();
    conflict(&db);
    let receipt = execute(&db, resolver_request()).unwrap();
    let job_id = receipt["job_id"].as_str().unwrap();
    execute(&db, json!({"op":"claim","job_id":job_id,"now":11})).unwrap();
    repair(&db, &request(), 12).unwrap();
    assert_eq!(get(&db, "jobs", job_id).unwrap()["status"], "cancelled");
    assert_eq!(
        get(&db, "executions", receipt["execution_id"].as_str().unwrap()).unwrap()["status"],
        "cancelled"
    );
    assert_eq!(get(&db, "jobs", job_id).unwrap()["epoch"], 2);
    let stops = execute(&db, json!({"op":"outbox"})).unwrap();
    assert!(
        stops["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["kind"] == "stop" && row["payload"]["job_id"] == job_id)
    );
}

#[test]
fn completed_integrated_failure_notifies_one_coordinator_without_a_duplicate_wake() {
    let db = fixture();
    conflict(&db);
    let mut execution = get(&db, "executions", "run:task:integrate").unwrap();
    execution["team_task"] = json!("run:task:integrate");
    execution["team_task_revision"] = json!(1);
    execution["epoch"] = json!(1);
    save(&db, "executions", "run:task:integrate", &execution).unwrap();
    let mut task = get(&db, "team_tasks", "run:task:integrate").unwrap();
    task["status"] = json!("evaluating");
    save(&db, "team_tasks", "run:task:integrate", &task).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    let candidate = get(&db, "candidates", "conflicted").unwrap();
    job(
        &db,
        "evaluate:conflicted",
        "evaluate",
        10,
        json!({"candidate":candidate,"policy":run["policy"]}),
    )
    .unwrap();
    execute(
        &db,
        json!({"op":"claim","job_id":"evaluate:conflicted","now":11}),
    )
    .unwrap();
    execute(&db,json!({"op":"finish","job_id":"evaluate:conflicted","epoch":1,"now":12,"result":{"id":"evaluation:failed","candidate":"conflicted","revision":candidate["revision"],"policy":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","checks":[{"name":"build","status":"fail","detail":"Fixture integration failed"}],"evidence":"e".repeat(64)}})).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    let coordinator = run["coordinator_execution_id"].as_str().unwrap();
    let job_id = format!("job:{coordinator}");
    execute(&db, json!({"op":"claim","job_id":job_id,"now":13})).unwrap();
    execute(&db,json!({"op":"finish","job_id":job_id,"epoch":1,"now":14,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    assert_eq!(
        run_executions(&db, "run")
            .unwrap()
            .iter()
            .filter(|e| e["team_role"] == "coordinator" && e["id"] != "coordinator")
            .count(),
        1,
        "One terminal evaluation must not replay as another coordination incident"
    );
}
