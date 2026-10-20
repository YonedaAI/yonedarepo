use super::*;
use crate::{execute, native::NativeStore};

pub(super) fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(&db, json!({"op":"init","now":1,"id":"repo","name":"Repair","remote":{"namespace":"test","name":"repo"},"commit":"a".repeat(40),"policy":{"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/index.js"],"timeout_seconds":30}]}}})).unwrap();
    execute(&db, json!({"op":"start_run","now":2,"id":"run","intent":"Build accessible source search","mode":"collaborate","agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"worker"},{"provider":"zai","model":"glm-5.3-flash","strategy":"integrator"}],"team":{"version":1,"contract":"Search API","integrator_agent":1,"integration_paths":["src/"],"tasks":[{"id":"api","title":"API","instructions":"Implement API","agent":0,"depends_on":[],"write_paths":["src/api.rs"]},{"id":"ui","title":"UI","instructions":"Use API","agent":0,"depends_on":["api"],"write_paths":["src/ui.rs"]},{"id":"other","title":"Other","instructions":"Independent","agent":0,"depends_on":[],"write_paths":["src/other.rs"]}]}})).unwrap();
    let mut run = get(&db, "runs", "run").unwrap();
    run["autonomy_policy"] = json!({"version":1,"enabled":true,"max_repair_rounds":2,"max_concurrent_agents":3,"max_executions":20,"source_scope":"project","allow_intent_questions":true});
    run["autonomy_approval"] = json!({"intent":run["intent"],"criteria":run["criteria"],"agents":run["agents"],"model_budgets":run["model_budgets"],"policy":run["policy"]});
    run["autonomy_policy_digest"] =
        json!(yoneda_core::fingerprint(&run["autonomy_policy"]).unwrap());
    run["approved_policy"] = run["policy"].clone();
    run["status"] = json!("exploring");
    // Candidate refresh and conflict resolution exist only for lazy-source runs.
    run["workspace_transport"] = json!("api-source-v1");
    save(&db, "runs", "run", &run).unwrap();
    for mut task in rows(&db, "team_tasks", "run").unwrap() {
        task["status"] = json!("complete");
        task["output"] = json!({"task_id":task["task_id"],"task_revision":1,"execution_id":task["id"],"paths":[],"revision":{"commit":"b".repeat(40)},"handoff_id":format!("handoff:{}",task["task_id"])});
        save(&db, "team_tasks", task["id"].as_str().unwrap(), &task).unwrap();
    }
    let e = json!({"id":"coordinator","run_id":"run","team_role":"coordinator","role":"coding","status":"running","provider":"zai","model":"glm-5.3-flash","harness":"claude","context":[],"base":run["base"],"budget":{"provider":"zai","model":"glm-5.3-flash"}});
    create(&db, "executions", "coordinator", &e).unwrap();
    create(&db,"jobs","job:coordinator",&json!({"id":"job:coordinator","kind":"agent","epoch":1,"status":"running","lease_until":10000,"attempt_deadline":10000,"payload":{"execution":e,"run":run,"policy":run["policy"],"team_planning":true}})).unwrap();
    db
}

pub(super) fn request() -> Value {
    json!({"op":"repair_team","job_id":"job:coordinator","epoch":1,"request_id":"fix-api","run_id":"run","expected_commit":"a".repeat(40),"expected_version":0,"expected_plan_revision":1,"task_ids":["api"],"expected_task_revisions":{"api":1,"ui":1,"integrate":1},"task_definitions":[{"id":"api","title":"API","instructions":"Correct API using the approved goal","agent":0,"depends_on":[],"write_paths":["src/api.rs"]}]})
}

#[test]
fn coordinator_amends_dag_fences_descendants_and_preserves_unchanged_outputs() {
    let db = fixture();
    let untouched = get(&db, "team_tasks", "run:task:other").unwrap();
    let before = get(&db, "runs", "run").unwrap();
    let result = repair(&db, &request(), 10).unwrap();
    assert_eq!(result["repair_round"], 1);
    assert_eq!(
        get(&db, "team_tasks", "run:task:ui").unwrap()["revision"],
        2
    );
    assert!(get(&db, "team_tasks", "run:task:integrate").unwrap()["output"].is_null());
    assert_eq!(get(&db, "team_tasks", "run:task:other").unwrap(), untouched);
    let run = get(&db, "runs", "run").unwrap();
    for key in ["intent", "policy", "model_budgets", "autonomy_policy"] {
        assert_eq!(run[key], before[key]);
    }
    assert_eq!(
        run["team_plan"]["tasks"][0]["instructions"],
        "Correct API using the approved goal"
    );
    assert_eq!(
        run["team_plan_amendments"][0]["approved_by"],
        "run_autonomy_policy"
    );
    assert_eq!(repair(&db, &request(), 11).unwrap(), result);
}

#[test]
fn coordinator_repair_requires_each_affected_version_before_mutating() {
    let db = fixture();
    let before = get(&db, "runs", "run").unwrap();
    let mut c = request();
    c["expected_task_revisions"]["ui"] = json!(0);
    assert_eq!(repair(&db, &c, 10).unwrap_err().code, "TASK_MOVED");
    assert_eq!(get(&db, "runs", "run").unwrap(), before);
}

#[test]
fn terminal_specialist_failure_schedules_one_read_only_coordinator_after_peers_settle() {
    let db = fixture();
    let mut task = get(&db, "team_tasks", "run:task:api").unwrap();
    task["status"] = json!("failed");
    save(&db, "team_tasks", "run:task:api", &task).unwrap();
    let mut other = get(&db, "team_tasks", "run:task:other").unwrap();
    other["status"] = json!("running");
    save(&db, "team_tasks", "run:task:other", &other).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    super::super::coordination::maybe_start(&db, &run, 10).unwrap();
    assert!(get(&db, "jobs", "job:run:coordinator:1:0:0").is_err());
    other["status"] = json!("complete");
    save(&db, "team_tasks", "run:task:other", &other).unwrap();
    super::super::coordination::maybe_start(&db, &run, 11).unwrap();
    super::super::coordination::maybe_start(&db, &run, 12).unwrap();
    let job = get(&db, "jobs", "job:run:coordinator:1:0:0").unwrap();
    assert_eq!(job["payload"]["team_planning"], true);
    assert_eq!(job["payload"]["execution"]["team_role"], "coordinator");
    assert_eq!(
        job["payload"]["execution"]["model"],
        run["agents"][1]["model"]
    );
    assert_eq!(job["payload"]["policy"], run["approved_policy"]);
    assert_eq!(
        get(&db, "runs", "run").unwrap()["team_repair_rounds"],
        Value::Null
    );
}

#[test]
fn awaiting_intent_prevents_tasks_becoming_queued_at_a_capture_checkpoint() {
    let db = fixture();
    let mut task = get(&db, "team_tasks", "run:task:ui").unwrap();
    task["status"] = json!("blocked");
    save(&db, "team_tasks", "run:task:ui", &task).unwrap();
    let mut run = get(&db, "runs", "run").unwrap();
    run["status"] = json!("awaiting_intent");
    save(&db, "runs", "run", &run).unwrap();
    super::super::scheduling::wake(&db, &run, 10).unwrap();
    assert_eq!(
        get(&db, "team_tasks", "run:task:ui").unwrap()["status"],
        "blocked"
    );
}

pub(super) fn conflict(db: &NativeStore) {
    let run = get(db, "runs", "run").unwrap();
    let e = json!({"id":"run:task:integrate","run_id":"run","team_role":"integrator","role":"coding","status":"completed","provider":"zai","model":"glm-5.3-flash","harness":"claude","context":[],"base":run["base"],"budget":{"provider":"zai","model":"glm-5.3-flash"}});
    create(db, "executions", "run:task:integrate", &e).unwrap();
    let candidate = json!({"id":"conflicted","execution":e["id"],"run_id":"run","base":run["base"],"revision":{"repository":"test/fork","commit":"c".repeat(40)},"status":"eligible","evaluation":"old","paths":["src/api.rs"]});
    create(db, "candidates", "conflicted", &candidate).unwrap();
    create(db,"conflicts","conflict",&json!({"id":"conflict","candidate":candidate,"candidate_id":"conflicted","status":"unresolved","head_commit":"a".repeat(40),"expected_version":0,"conflict_paths":["src/api.rs"],"workspace_revision":{"repository":"test/merge","commit":"d".repeat(40)},"merge_workspace_commit":"d".repeat(40),"candidate_revision":"c".repeat(40),"candidate_base":"a".repeat(40),"evidence":{}})).unwrap();
}

pub(super) fn resolver_request() -> Value {
    json!({"op":"resolve_conflict","job_id":"job:coordinator","epoch":1,"request_id":"resolve","conflict_id":"conflict","expected_commit":"a".repeat(40),"expected_version":0,"expected_plan_revision":1,"expected_task_revisions":{"api":1,"integrate":1},"now":10})
}

#[test]
fn autonomous_resolver_uses_intent_and_existing_budget_without_owner_brief_or_publication() {
    let db = fixture();
    conflict(&db);
    let before = get(&db, "runs", "run").unwrap();
    let receipt = execute(&db, resolver_request()).unwrap();
    let job = get(&db, "jobs", receipt["job_id"].as_str().unwrap()).unwrap();
    let e = &job["payload"]["execution"];
    assert!(
        e["task"]
            .as_str()
            .unwrap()
            .contains("Build accessible source search")
    );
    assert_eq!(
        e["budget"],
        json!({"provider":"zai","model":"glm-5.3-flash"})
    );
    assert_eq!(job["payload"]["policy"], before["approved_policy"]);
    assert_eq!(get(&db, "runs", "run").unwrap()["team_repair_rounds"], 1);
    assert!(all(&db, "decisions").unwrap().is_empty());
    assert!(
        !all(&db, "jobs")
            .unwrap()
            .iter()
            .any(|j| j["kind"] == "publish")
    );
    assert_eq!(execute(&db, resolver_request()).unwrap(), receipt);
}

#[test]
fn branch_refresh_and_resolver_target_checked_head_instead_of_canonical() {
    let db = fixture();
    conflict(&db);
    create(&db,"working_branches","branch",&json!({"id":"branch","status":"active","working_commit":"b".repeat(40),"working_revision":{"repository":"test/checked","commit":"b".repeat(40)},"version":1,"canonical_base_commit":"a".repeat(40),"canonical_base_version":0})).unwrap();
    let mut run = get(&db, "runs", "run").unwrap();
    run["working_branch_id"] = json!("branch");
    run["working_branch_version"] = json!(0);
    save(&db, "runs", "run", &run).unwrap();
    let refresh = execute(&db,json!({"op":"refresh_candidate","request_id":"branch-refresh","candidate_id":"conflicted","expected_commit":"b".repeat(40),"expected_version":1,"now":10})).unwrap();
    let job = get(&db, "jobs", refresh["job_id"].as_str().unwrap()).unwrap();
    assert_eq!(job["payload"]["expected_head"], "b".repeat(40));
    assert_eq!(job["payload"]["working_branch_id"], "branch");
    assert_eq!(
        job["payload"]["target_revision"],
        json!({"repository":"test/checked","commit":"b".repeat(40)})
    );
    let mut record = get(&db, "conflicts", "conflict").unwrap();
    record["head_commit"] = json!("b".repeat(40));
    record["expected_version"] = json!(1);
    record["working_branch_id"] = json!("branch");
    record["target_revision"] = job["payload"]["target_revision"].clone();
    save(&db, "conflicts", "conflict", &record).unwrap();
    let mut c = resolver_request();
    c["expected_commit"] = json!("b".repeat(40));
    c["expected_version"] = json!(1);
    let resolver = execute(&db, c).unwrap();
    let job = get(&db, "jobs", resolver["job_id"].as_str().unwrap()).unwrap();
    assert_eq!(
        job["payload"]["execution"]["base"],
        record["target_revision"]
    );
    assert_eq!(repo(&db).unwrap()["head_commit"], "a".repeat(40));
}
