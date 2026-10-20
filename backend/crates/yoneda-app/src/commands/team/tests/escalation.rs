//! Native frozen-approval fixtures exercise dispatch only, without provider calls.
use super::autonomous_tests::{conflict, fixture, request, resolver_request};
use super::*;
use crate::{commands::source_kit::execute, native::NativeStore};

fn approve_escalation(db: &NativeStore) {
    let mut run = get(db, "runs", "run").unwrap();
    let budget = json!({"provider":"claude","model":"claude-opus-5-5","max_requests":8,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":1000000,"pricing":{"input_microusd_per_million":8000000,"output_microusd_per_million":20000000,"source":"owner-approved conservative rates"}});
    run["model_budgets"]
        .as_array_mut()
        .unwrap()
        .push(budget.clone());
    run["repair_escalation"] = json!({"version":1,"provider":"claude","model":"claude-opus-5-5","connection":"approved-opus","budget":budget,"max_executions":1,"repair_round":2,"after_cheaper_repair_failure":true});
    run["autonomy_approval"]["model_budgets"] = run["model_budgets"].clone();
    save(db, "runs", "run", &run).unwrap();
    let mut job = get(db, "jobs", "job:coordinator").unwrap();
    job["payload"]["run"] = run;
    save(db, "jobs", "job:coordinator", &job).unwrap();
}

fn fail_cheaper_repair(db: &NativeStore) {
    repair(db, &request(), 10).unwrap();
    let mut task = get(db, "team_tasks", "run:task:api").unwrap();
    task["status"] = json!("failed");
    save(db, "team_tasks", "run:task:api", &task).unwrap();
    let mut job = get(db, "jobs", "job:run:task:api").unwrap();
    job["status"] = json!("failed");
    job["attempt"] = json!(2);
    save(db, "jobs", "job:run:task:api", &job).unwrap();
    super::super::coordination::maybe_start(db, &get(db, "runs", "run").unwrap(), 11).unwrap();
    assert_eq!(
        get(db, "runs", "run").unwrap()["team_repair_failure"]["round"],
        1
    );
}

#[test]
fn failed_cheaper_repair_dispatches_only_one_preapproved_opus_source_execution() {
    let db = fixture();
    approve_escalation(&db);
    fail_cheaper_repair(&db);
    let before = get(&db, "runs", "run").unwrap()["model_budgets"].clone();
    let mut second = request();
    second["request_id"] = json!("second");
    second["expected_plan_revision"] = json!(2);
    second["task_ids"] = json!(["api", "other"]);
    second["expected_task_revisions"] = json!({"api":2,"ui":2,"other":1,"integrate":2});
    second["task_definitions"].as_array_mut().unwrap().push(json!({"id":"other","title":"Other","instructions":"Independent","agent":1,"depends_on":[],"write_paths":["src/other.rs"]}));
    repair(&db, &second, 12).unwrap();
    let job = get(&db, "jobs", "job:run:task:api").unwrap();
    assert_eq!(job["payload"]["execution"]["model"], "claude-opus-5-5");
    assert_eq!(job["payload"]["execution"]["connection"], "approved-opus");
    assert_eq!(job["payload"]["execution"]["repair_round"], 2);
    assert_eq!(job["payload"]["run"]["campaign_opus"]["used"], true);
    assert_eq!(
        job["payload"]["run"]["campaign_opus"]["execution_id"],
        job["payload"]["execution"]["id"]
    );
    let other = get(&db, "jobs", "job:run:task:other").unwrap();
    assert_eq!(other["payload"]["execution"]["model"], "glm-5.3-flash");
    assert_eq!(other["payload"]["execution"]["repair_round"], 2);
    assert_eq!(
        other["payload"]["run"]["campaign_opus"],
        job["payload"]["run"]["campaign_opus"]
    );
    assert_eq!(get(&db, "runs", "run").unwrap()["model_budgets"], before);
    assert_eq!(
        get(&db, "runs", "run").unwrap()["campaign_opus"]["used"],
        true
    );
    assert_eq!(
        run_executions(&db, "run")
            .unwrap()
            .iter()
            .filter(|e| e["model"] == "claude-opus-5-5")
            .count(),
        1
    );
}

#[test]
fn second_round_resolver_can_claim_opus_without_a_separate_run_or_extra_round() {
    let db = fixture();
    approve_escalation(&db);
    conflict(&db);
    fail_cheaper_repair(&db);
    let mut c = resolver_request();
    c["expected_plan_revision"] = json!(2);
    c["expected_task_revisions"] = json!({"api":2,"integrate":2});
    let receipt = execute(&db, c).unwrap();
    let job = get(&db, "jobs", receipt["job_id"].as_str().unwrap()).unwrap();
    assert_eq!(job["payload"]["execution"]["model"], "claude-opus-5-5");
    assert_eq!(job["payload"]["execution"]["run_id"], "run");
    assert_eq!(job["payload"]["run"]["campaign_opus"]["used"], true);
    assert_eq!(
        job["payload"]["run"]["campaign_opus"]["execution_id"],
        job["payload"]["execution"]["id"]
    );
    assert_eq!(get(&db, "runs", "run").unwrap()["team_repair_rounds"], 2);
    assert_eq!(all(&db, "runs").unwrap().len(), 1);
    assert!(
        !run_executions(&db, "run")
            .unwrap()
            .iter()
            .any(|e| e["team_role"] == "coordinator" && e["model"] == "claude-opus-5-5")
    );
}
