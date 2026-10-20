use super::autonomous_tests::{conflict, fixture};
use super::*;
use crate::{commands::source_kit::execute, native::NativeStore};

fn setup() -> (NativeStore, Value) {
    let db = fixture();
    execute(&db,json!({"op":"create_working_branch","id":"branch","expected_commit":"a".repeat(40),"expected_version":0,"now":3})).unwrap();
    let mut run = get(&db, "runs", "run").unwrap();
    run["working_branch_id"] = json!("branch");
    run["working_branch_version"] = json!(0);
    run["coordinator_execution_id"] = json!("coordinator");
    run["status"] = json!("coordinating");
    save(&db, "runs", "run", &run).unwrap();
    let mut coordinator = get(&db, "jobs", "job:coordinator").unwrap();
    coordinator["payload"]["run"] = run.clone();
    save(&db, "jobs", "job:coordinator", &coordinator).unwrap();
    conflict(&db);
    let mut execution = get(&db, "executions", "run:task:integrate").unwrap();
    execution["team_task"] = json!("run:task:integrate");
    execution["team_task_revision"] = json!(1);
    save(&db, "executions", "run:task:integrate", &execution).unwrap();
    let mut task = get(&db, "team_tasks", "run:task:integrate").unwrap();
    task["status"] = json!("evaluating");
    save(&db, "team_tasks", "run:task:integrate", &task).unwrap();
    let mut candidate = get(&db, "candidates", "conflicted").unwrap();
    candidate["capture_job"] = json!("capture:before-question");
    save(&db, "candidates", "conflicted", &candidate).unwrap();
    create(&db,"jobs","capture:before-question",&json!({"id":"capture:before-question","kind":"capture","status":"done","payload":{"execution":execution,"intent_epoch":0}})).unwrap();
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
    let question=execute(&db,json!({"op":"intent_question","job_id":"job:coordinator","epoch":1,"request_id":"pending","question":"Include archived source?","options":["Active only","All source"],"now":12})).unwrap();
    execute(&db,json!({"op":"finish","job_id":"job:coordinator","epoch":1,"now":13,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    (db, question)
}

fn finish_evaluation(db: &NativeStore, id: &str, candidate: &Value, pass: bool, now: i64) {
    execute(db,json!({"op":"finish","job_id":id,"epoch":1,"now":now,"result":{"id":format!("evaluation:{id}"),"candidate":candidate["id"],"revision":candidate["revision"],"policy":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","checks":[{"name":"build","status":if pass{"pass"}else{"fail"},"detail":"Native concurrent evaluation fixture"}],"evidence":"e".repeat(64)}})).unwrap();
}

fn publish(db: &NativeStore) -> Result<Value> {
    execute(
        db,
        json!({"op":"accept","request_id":"forbidden-publication","candidate":"conflicted","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Must not publish held source","now":20}),
    )
}

fn pending_evaluation(pass: bool) {
    let (db, question) = setup();
    let candidate = get(&db, "candidates", "conflicted").unwrap();
    finish_evaluation(&db, "evaluate:conflicted", &candidate, pass, 14);
    assert_eq!(
        get(&db, "runs", "run").unwrap()["status"],
        "awaiting_intent"
    );
    assert_eq!(
        get(&db, "working_branches", "branch").unwrap()["version"],
        0
    );
    assert_eq!(
        get(&db, "candidates", "conflicted").unwrap()["status"],
        "awaiting_intent"
    );
    assert!(get(&db, "evaluations", "evaluation:evaluate:conflicted").is_ok());
    assert_eq!(publish(&db).unwrap_err().code, "FENCED");
    execute(&db,json!({"op":"answer_intent","run_id":"run","question_id":question["id"],"answer":"Active only","now":15})).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    let coordinator = get(
        &db,
        "jobs",
        &format!("job:{}", run["coordinator_execution_id"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(
        coordinator["payload"]["run"]["intent_clarifications"][0]["answer"],
        "Active only"
    );
    assert_eq!(run["team_repair_rounds"], Value::Null);
    assert_eq!(publish(&db).unwrap_err().code, "FENCED");
    job(
        &db,
        "evaluate:held-again",
        "evaluate",
        16,
        json!({"candidate":candidate,"policy":run["policy"]}),
    )
    .unwrap();
    execute(
        &db,
        json!({"op":"claim","job_id":"evaluate:held-again","now":17}),
    )
    .unwrap();
    finish_evaluation(&db, "evaluate:held-again", &candidate, true, 18);
    assert_eq!(
        get(&db, "candidates", "conflicted").unwrap()["status"],
        "awaiting_intent"
    );
    assert_eq!(
        get(&db, "working_branches", "branch").unwrap()["version"],
        0
    );
    assert_eq!(publish(&db).unwrap_err().code, "FENCED");
}

#[test]
fn passing_active_evaluation_cannot_unpause_or_publish_before_or_after_owner_answer() {
    pending_evaluation(true);
}

#[test]
fn failed_active_evaluation_retains_pending_question_and_owner_can_answer() {
    pending_evaluation(false);
}

#[test]
fn answering_before_active_evaluation_finishes_still_requires_post_answer_source() {
    let (db, question) = setup();
    execute(&db,json!({"op":"answer_intent","run_id":"run","question_id":question["id"],"answer":"Active only","now":14})).unwrap();
    let candidate = get(&db, "candidates", "conflicted").unwrap();
    finish_evaluation(&db, "evaluate:conflicted", &candidate, true, 15);
    assert_eq!(
        get(&db, "candidates", "conflicted").unwrap()["status"],
        "awaiting_intent"
    );
    assert_eq!(
        get(&db, "working_branches", "branch").unwrap()["version"],
        0
    );
    assert_eq!(publish(&db).unwrap_err().code, "FENCED");
}

#[test]
fn fresh_post_answer_capture_approval_and_evaluation_can_advance_the_working_branch() {
    let (db, question) = setup();
    let old_job = get(&db, "jobs", "job:coordinator").unwrap();
    let mut payload = json!({});
    super::super::capture_payload(&db, &old_job, &mut payload, 14).unwrap();
    assert_eq!(
        payload["intent_epoch"], 0,
        "Capture uses source approval, not current run state"
    );
    execute(&db,json!({"op":"answer_intent","run_id":"run","question_id":question["id"],"answer":"Active only","now":15})).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    let mut source = old_job;
    source["payload"]["run"] = run.clone();
    super::super::capture_payload(&db, &source, &mut payload, 16).unwrap();
    assert_eq!(payload["intent_epoch"], run["intent_epoch"]);
    create(
        &db,
        "jobs",
        "capture:post-answer",
        &json!({"id":"capture:post-answer","kind":"capture","status":"done","payload":payload}),
    )
    .unwrap();
    let candidate = json!({"id":"post-answer","execution":"run:task:integrate","run_id":"run","capture_job":"capture:post-answer","base":run["base"],"revision":{"repository":"test/fresh-post-answer","commit":"b".repeat(40)},"status":"evaluating"});
    create(&db, "candidates", "post-answer", &candidate).unwrap();
    job(
        &db,
        "evaluate:post-answer",
        "evaluate",
        17,
        json!({"candidate":candidate,"policy":run["policy"]}),
    )
    .unwrap();
    execute(
        &db,
        json!({"op":"claim","job_id":"evaluate:post-answer","now":18}),
    )
    .unwrap();
    finish_evaluation(&db, "evaluate:post-answer", &candidate, true, 19);
    assert_eq!(
        get(&db, "candidates", "post-answer").unwrap()["status"],
        "eligible"
    );
    let branch = get(&db, "working_branches", "branch").unwrap();
    assert_eq!(branch["version"], 1);
    assert_eq!(branch["working_commit"], "b".repeat(40));
    assert_eq!(
        get(&db, "candidates", "conflicted").unwrap()["status"],
        "awaiting_intent"
    );
}
