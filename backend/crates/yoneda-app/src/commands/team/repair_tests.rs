use super::*;
use crate::{execute, native::NativeStore};

fn start(db: &NativeStore) {
    execute(db, json!({"op":"init","now":10,"id":"repair-repo","name":"Repair","remote":{"namespace":"test","name":"repair"},"commit":"a".repeat(40),"policy":{"version":"repair-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/index.js"],"timeout_seconds":30}]}}})).unwrap();
    execute(db, json!({"op":"start_run","now":11,"id":"repair-run","intent":"Build with a bounded team","mode":"collaborate","agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"worker"},{"provider":"zai","model":"glm-5.3-flash","strategy":"integrator"}],"team":{"version":1,"contract":"One shared API","integrator_agent":1,"integration_paths":["src/"],"tasks":[{"id":"upstream","title":"Upstream","instructions":"Implement upstream","agent":0,"depends_on":[],"write_paths":["src/upstream.rs"]},{"id":"downstream","title":"Downstream","instructions":"Use upstream","agent":0,"depends_on":["upstream"],"write_paths":["src/downstream.rs"]},{"id":"independent","title":"Independent","instructions":"Independent work","agent":0,"depends_on":[],"write_paths":["src/independent.rs"]}]}})).unwrap();
    for (local, agent, deps) in [
        ("upstream", 0, json!([])),
        ("downstream", 0, json!(["upstream"])),
        ("independent", 0, json!([])),
        (
            "integrate",
            1,
            json!(["upstream", "downstream", "independent"]),
        ),
    ] {
        let id = format!("repair-run:task:{local}");
        let mut task = get(db, "team_tasks", &id).unwrap();
        task["status"] = json!("complete");
        task["output"] = json!({"task_id":local,"execution_id":id,"paths":[format!("src/{local}.rs")],"revision":{"commit":"b".repeat(40)},"handoff_id":format!("handoff:{local}")});
        task["agent"] = json!(agent);
        task["depends_on"] = deps;
        save(db, "team_tasks", &id, &task).unwrap();
    }
    let mut run = get(db, "runs", "repair-run").unwrap();
    run["status"] = json!("ready");
    save(db, "runs", "repair-run", &run).unwrap();
    create(
        db,
        "evaluations",
        "old-evaluation",
        &json!({"id":"old-evaluation","candidate":"old-candidate","checks":[{"status":"fail"}]}),
    )
    .unwrap();
    create(db,"candidates","old-candidate",&json!({"id":"old-candidate","execution":"repair-run:task:integrate","run_id":"repair-run","status":"rejected","evaluation":"old-evaluation"})).unwrap();
}

#[test]
fn owner_repair_after_integration_failure_preserves_unaffected_and_fences_old_revision() {
    let db = NativeStore::memory().unwrap();
    start(&db);
    let before = get(&db, "team_tasks", "repair-run:task:downstream").unwrap();
    let independent_before = get(&db, "team_tasks", "repair-run:task:independent").unwrap();
    let request = json!({"op":"repair_team","request_id":"repair-1","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":1,"task_ids":["upstream"],"expected_task_revisions":{"upstream":1},"owner_brief":"Correct the upstream behavior"});
    let result = repair(&db, &request, 20).unwrap();
    assert_eq!(result["repair_round"], 1);
    assert_eq!(repair(&db, &request, 21).unwrap(), result);
    let mut changed = request.clone();
    changed["owner_brief"] = json!("Changed input");
    assert_eq!(
        repair(&db, &changed, 22).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
    assert_eq!(
        get(&db, "team_tasks", "repair-run:task:upstream").unwrap()["revision"],
        2
    );
    let downstream = get(&db, "team_tasks", "repair-run:task:downstream").unwrap();
    assert_eq!(downstream["status"], "blocked");
    assert!(downstream["output"].is_null());
    assert_eq!(before["revision"], 1);
    assert_eq!(
        get(&db, "team_tasks", "repair-run:task:independent").unwrap()["output"],
        independent_before["output"]
    );
    assert_eq!(
        get(&db, "team_tasks", "repair-run:task:integrate").unwrap()["status"],
        "blocked"
    );
    assert_eq!(
        get(&db, "candidates", "old-candidate").unwrap()["status"],
        "stale"
    );
    assert_eq!(
        get(&db, "evaluations", "old-evaluation").unwrap()["checks"][0]["status"],
        "fail"
    );
    assert_eq!(
        get(&db, "runs", "repair-run").unwrap()["team_plan_revision"],
        2
    );
    let stale_job = json!({"payload":{"execution":{"id":"repair-run:task:upstream","run_id":"repair-run","team_task":"repair-run:task:upstream","team_task_revision":1}},"epoch":1});
    assert_eq!(
        super::super::captured(&db, &stale_job, &json!({"paths":[]}), 21)
            .unwrap_err()
            .code,
        "FENCED"
    );
}

#[test]
fn repair_budget_is_two_rounds_and_does_not_revise_run_model_budgets() {
    let db = NativeStore::memory().unwrap();
    start(&db);
    let budgets = get(&db, "runs", "repair-run").unwrap()["model_budgets"].clone();
    let first = json!({"op":"repair_team","request_id":"repair-1","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":1,"task_ids":["upstream"],"expected_task_revisions":{"upstream":1},"owner_brief":"First repair"});
    repair(&db, &first, 20).unwrap();
    let second = json!({"op":"repair_team","request_id":"repair-2","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":2,"task_ids":["upstream"],"expected_task_revisions":{"upstream":2},"owner_brief":"Second repair"});
    repair(&db, &second, 30).unwrap();
    assert_eq!(
        get(&db, "runs", "repair-run").unwrap()["model_budgets"],
        budgets
    );
    let third = json!({"op":"repair_team","request_id":"repair-3","expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-run","expected_plan_revision":3,"task_ids":["upstream"],"expected_task_revisions":{"upstream":3},"owner_brief":"Third repair"});
    assert_eq!(
        repair(&db, &third, 40).unwrap_err().code,
        "REPAIR_BUDGET_EXHAUSTED"
    );
}

#[test]
fn retry_restores_frozen_git_transport_on_an_older_repaired_job() {
    let db = NativeStore::memory().unwrap();
    start(&db);
    let mut run = get(&db, "runs", "repair-run").unwrap();
    run["workspace_transport"] = json!("git-native-v1");
    run["status"] = json!("exploring");
    save(&db, "runs", "repair-run", &run).unwrap();

    for local in ["downstream", "integrate"] {
        let id = format!("repair-run:task:{local}");
        let mut task = get(&db, "team_tasks", &id).unwrap();
        task["status"] = json!("blocked");
        task["epoch"] = json!(0);
        task["output"] = Value::Null;
        save(&db, "team_tasks", &id, &task).unwrap();
    }
    let execution_id = "repair-run:task:upstream";
    let mut task = get(&db, "team_tasks", execution_id).unwrap();
    task["status"] = json!("failed");
    task["epoch"] = json!(1);
    task["output"] = Value::Null;
    save(&db, "team_tasks", execution_id, &task).unwrap();
    let execution = json!({
        "id":execution_id, "run_id":"repair-run", "harness":"claude", "provider":"mimo",
        "model":"mimo-v2.6-flash", "role":"coding", "status":"failed",
        "context":[], "base":run["base"], "team_task":execution_id,
        "team_task_revision":1, "team_role":"worker", "depth":0,
        "budget":{"provider":"mimo","model":"mimo-v2.6-flash"}
    });
    create(&db, "executions", execution_id, &execution).unwrap();
    create(
        &db,
        "jobs",
        &format!("job:{execution_id}"),
        &json!({
            "id":format!("job:{execution_id}"), "kind":"agent", "status":"failed",
            "attempt":2, "epoch":1, "lease_until":0, "deadline":2_000_000,
            "dispatch_deadline":1_500_000, "payload":{"execution":execution,"run":run,"policy":run["policy"]}
        }),
    )
    .unwrap();

    crate::execute(
        &db,
        json!({"op":"retry_team_task","now":1000,"run_id":"repair-run","task_id":"upstream","expected_epoch":1,"expected_revision":1}),
    )
    .unwrap();

    let retried = get(&db, "jobs", &format!("job:{execution_id}")).unwrap();
    assert_eq!(retried["payload"]["workspace_transport"], "git-native-v1");
    assert_eq!(retried["payload"]["execution"]["team_task_revision"], 2);
}
