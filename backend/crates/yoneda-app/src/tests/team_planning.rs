use super::*;
#[path = "team_planning/drafts.rs"]
mod drafts;
fn automatic(agents: usize) -> Value {
    json!({"op":"start_run","id":"auto","intent":"Build an events website with search and registration","mode":"collaborate","team":null,"agents":(0..agents).map(|n|json!({"provider":"mimo","model":"mimo-v2.6-flash","strategy":format!("agent-{n}")})).collect::<Vec<_>>()})
}
fn proposed(agents: usize) -> Value {
    json!({"version":1,"contract":"Modules export filterEvents and rsvp; index provides accessible interaction","integrator_agent":0,"integration_paths":["public/index.js"],"tasks":(0..agents).map(|n|json!({"id":format!("feature-{n}"),"title":format!("Feature {n}"),"instructions":"Implement the assigned interface in the shared contract","agent":n,"depends_on":[],"write_paths":[format!("public/feature-{n}.js")]})).collect::<Vec<_>>()})
}
fn proposal(plan: Value, epoch: i64) -> Value {
    json!({"op":"team_plan_propose","job_id":"job:auto:planner","epoch":epoch,"plan":plan,"author":"spoofed","verified":true})
}
fn finish(epoch: i64) -> Value {
    json!({"op":"finish","job_id":"job:auto:planner","epoch":epoch,"result":{"planning":true,"source_unchanged":true,"transcript":"f".repeat(64),"model":"mimo-v2.6-flash"}})
}
fn snapshot(db: &NativeStore) -> Value {
    call(db, json!({"op":"snapshot"})).unwrap()
}
fn claim(db: &NativeStore) -> Value {
    call(db, json!({"op":"claim","job_id":"job:auto:planner"})).unwrap()
}
fn setup(agents: usize) -> NativeStore {
    let db = repo_with_policy(single_agent::policy());
    call(&db, automatic(agents)).unwrap();
    db
}
#[test]
fn automatic_team_one_and_two_agents_plan_before_any_source_task_dispatch() {
    for agents in [1, 2] {
        let db = repo_with_policy(single_agent::policy());
        let mut start = automatic(agents);
        start["model_budgets"] = json!([{"provider":"mimo","model":"mimo-v2.6-flash","max_requests":2,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null}]);
        call(&db, start).unwrap();
        let s = snapshot(&db);
        assert_eq!(s["runs"][0]["status"], "planning");
        assert_eq!(s["runs"][0]["team_planning"], "automatic");
        assert_eq!(s["executions"].as_array().unwrap().len(), 1);
        assert_eq!(s["executions"][0]["team_role"], "planner");
        assert!(s["executions"][0].get("team_task").is_none());
        assert_eq!(s["team_tasks"], json!([]));
        let job = claim(&db);
        assert_eq!(job["payload"]["team_planning"], true);
        let reserved=call(&db,json!({"op":"reserve_request","job_id":job["id"],"epoch":1,"kind":"model","input_bytes":100,"output_tokens":4096})).unwrap();
        assert_eq!(reserved["run_number"], 1);
        call(
            &db,
            json!({"op":"hint_complete","job_id":job["id"],"epoch":1,"summary":"Ready to plan"}),
        )
        .unwrap();
        assert_eq!(snapshot(&db)["team_tasks"], json!([]));
        let context = call(
            &db,
            json!({"op":"team_context","job_id":job["id"],"epoch":1}),
        )
        .unwrap();
        assert_eq!(context["agents"].as_array().unwrap().len(), agents);
        let p = call(&db, proposal(proposed(agents), 1)).unwrap();
        assert_eq!(p["author"], "auto:planner");
        assert_eq!(p["data"]["authority"], "assertion");
        assert_eq!(snapshot(&db)["team_tasks"], json!([]));
        assert_eq!(call(&db, proposal(proposed(agents), 1)).unwrap(), p);
        call(
            &db,
            json!({"op":"hint_complete","job_id":job["id"],"epoch":1,"summary":"Plan proposed"}),
        )
        .unwrap();
        assert_eq!(snapshot(&db)["team_tasks"], json!([]));
        call(&db, finish(1)).unwrap();
        let after = snapshot(&db);
        assert_eq!(after["runs"][0]["status"], "exploring");
        assert_eq!(after["runs"][0]["team_plan_revision"], 1);
        assert_eq!(after["runs"][0]["team_plan"], proposed(agents));
        assert_eq!(after["team_tasks"].as_array().unwrap().len(), agents + 1);
        assert_eq!(after["executions"].as_array().unwrap().len(), agents + 1);
        assert_eq!(after["candidates"], json!([]));
        let capture_dispatches = call(&db, json!({"op":"outbox"})).unwrap()["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|j| j["kind"] == "capture")
            .count();
        assert_eq!(capture_dispatches, 0);
        assert_eq!(call(&db, finish(1)).unwrap_err().code, "FENCED");
        assert_eq!(snapshot(&db)["team_tasks"], after["team_tasks"]);
        call(
            &db,
            json!({"op":"claim","job_id":"job:auto:task:feature-0"}),
        )
        .unwrap();
        let reserve = json!({"op":"reserve_request","job_id":"job:auto:task:feature-0","epoch":1,"kind":"model","input_bytes":100,"output_tokens":4096});
        assert_eq!(call(&db, reserve.clone()).unwrap()["run_number"], 2);
        assert_eq!(call(&db, reserve).unwrap_err().code, "MODEL_REQUEST_LIMIT");
    }
}
#[test]
fn invalid_absent_conflicting_and_mutated_source_proposals_never_schedule_tasks() {
    let db = setup(2);
    claim(&db);
    assert_eq!(call(&db, finish(1)).unwrap_err().code, "MISSING_TEAM_PLAN");
    let mut invalid = proposed(2);
    invalid["tasks"][0]["depends_on"] = json!(["feature-1"]);
    invalid["tasks"][1]["depends_on"] = json!(["feature-0"]);
    assert_eq!(
        call(&db, proposal(invalid, 1)).unwrap_err().code,
        "INVALID_INPUT"
    );
    assert_eq!(snapshot(&db)["team_tasks"], json!([]));
    call(&db, proposal(proposed(2), 1)).unwrap();
    let mut other = proposed(2);
    other["contract"] = json!("Changed contract");
    assert_eq!(
        call(&db, proposal(other, 1)).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
    for marker in ["source_unchanged", "planning", "workspace"] {
        let mut completion = finish(1);
        if marker == "workspace" {
            completion["result"][marker] = json!("c".repeat(64));
        } else {
            completion["result"][marker] = json!(false);
        }
        assert_eq!(
            call(&db, completion).unwrap_err().code,
            "PLANNING_SOURCE_CHANGED"
        );
        assert_eq!(snapshot(&db)["team_tasks"], json!([]));
    }
    assert_eq!(snapshot(&db)["runs"][0]["status"], "planning");
}
#[test]
fn old_attempt_proposals_cannot_survive_retry_or_cancellation() {
    let db = setup(1);
    claim(&db);
    call(&db, proposal(proposed(1), 1)).unwrap();
    call(&db,json!({"op":"fail","job_id":"job:auto:planner","epoch":1,"error":"Simulated read-only harness loss","retryable":true})).unwrap();
    assert_eq!(snapshot(&db)["runs"][0]["status"], "planning");
    assert_eq!(claim(&db)["epoch"], 2);
    assert_eq!(
        call(&db, proposal(proposed(1), 1)).unwrap_err().code,
        "FENCED"
    );
    assert_eq!(call(&db, finish(2)).unwrap_err().code, "MISSING_TEAM_PLAN");
    call(&db, proposal(proposed(1), 2)).unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"auto"})).unwrap();
    assert_eq!(call(&db, finish(2)).unwrap_err().code, "FENCED");
    assert_eq!(
        call(&db, proposal(proposed(1), 2)).unwrap_err().code,
        "FENCED"
    );
    assert_eq!(snapshot(&db)["team_tasks"], json!([]));
}
#[test]
fn nonplanner_and_nonhosted_calls_cannot_propose_and_manual_one_agent_remains_supported() {
    let db = repo_with_policy(single_agent::policy());
    let mut manual = automatic(1);
    manual["team"] = proposed(1);
    call(&db, manual).unwrap();
    assert_eq!(snapshot(&db)["runs"][0]["status"], "exploring");
    assert!(snapshot(&db)["runs"][0].get("team_planning").is_none());
    call(
        &db,
        json!({"op":"claim","job_id":"job:auto:task:feature-0"}),
    )
    .unwrap();
    let mut forged = proposal(proposed(1), 1);
    forged["job_id"] = json!("job:auto:task:feature-0");
    assert_eq!(call(&db, forged).unwrap_err().code, "FORBIDDEN");
    assert_eq!(
        call(&db, json!({"op":"team_plan_propose","plan":proposed(1)}))
            .unwrap_err()
            .code,
        "INVALID_INPUT"
    );
    let db = setup(1);
    claim(&db);
    call(&db,json!({"op":"fail","job_id":"job:auto:planner","epoch":1,"error":"No valid plan","retryable":false})).unwrap();
    assert_eq!(snapshot(&db)["runs"][0]["status"], "failed");
    let mut next = automatic(1);
    next["id"] = json!("restarted");
    next["restart_of"] = json!("auto");
    call(&db, next).unwrap();
    assert_eq!(snapshot(&db)["runs"][1]["status"], "planning");
}

#[test]
fn one_roster_agent_reserves_one_task_until_trusted_capture_then_reuses_the_slot() {
    let db = setup(1);
    claim(&db);
    let mut plan = proposed(1);
    let mut second = plan["tasks"][0].clone();
    second["id"] = json!("feature-1");
    second["title"] = json!("Another feature");
    second["write_paths"] = json!(["public/feature-1.js"]);
    plan["tasks"].as_array_mut().unwrap().push(second);
    call(&db, proposal(plan, 1)).unwrap();
    call(&db, finish(1)).unwrap();
    let task_status = |local: &str| {
        snapshot(&db)["team_tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["task_id"] == local)
            .unwrap()["status"]
            .clone()
    };
    assert_eq!(task_status("feature-0"), "queued");
    assert_eq!(task_status("feature-1"), "blocked");
    assert_eq!(
        snapshot(&db)["executions"].as_array().unwrap().len(),
        2,
        "planner and one worker; no second reservation"
    );
    call(
        &db,
        json!({"op":"claim","job_id":"job:auto:task:feature-0"}),
    )
    .unwrap();
    call(&db,json!({"op":"fail","job_id":"job:auto:task:feature-0","epoch":1,"error":"Simulated failure","retryable":true})).unwrap();
    let retried = call(
        &db,
        json!({"op":"claim","job_id":"job:auto:task:feature-0"}),
    )
    .unwrap();
    assert_eq!(task_status("feature-1"), "blocked");
    call(&db,json!({"op":"finish","job_id":retried["id"],"epoch":retried["epoch"],"result":{"workspace":"b".repeat(64)}})).unwrap();
    assert_eq!(task_status("feature-0"), "capturing");
    assert_eq!(task_status("feature-1"), "blocked");
    let capture = call(
        &db,
        json!({"op":"claim","job_id":"capture:auto:task:feature-0"}),
    )
    .unwrap();
    call(&db,json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],"result":{"id":"first-task-output","revision":{"repository":"test/feature0","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/feature-0.js"],"summary":"Captured first feature","diff":"x"}})).unwrap();
    assert_eq!(task_status("feature-0"), "complete");
    assert_eq!(task_status("feature-1"), "queued");
    assert_eq!(
        snapshot(&db)["executions"].as_array().unwrap().len(),
        3,
        "second worker only reserved after capture"
    );
    // A duplicate completion is fenced and cannot dispatch a second copy of the queued task.
    assert_eq!(
        call(
            &db,
            json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],"result":{}})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    assert_eq!(snapshot(&db)["executions"].as_array().unwrap().len(), 3);
}

#[test]
fn an_owner_retry_cannot_overlap_another_task_reserved_on_the_same_roster_index() {
    let db = setup(2);
    claim(&db);
    let mut plan = proposed(2);
    let mut extra = plan["tasks"][0].clone();
    extra["id"] = json!("feature-2");
    extra["write_paths"] = json!(["public/feature-2.js"]);
    plan["tasks"].as_array_mut().unwrap().push(extra);
    call(&db, proposal(plan, 1)).unwrap();
    call(&db, finish(1)).unwrap();
    // Both different roster indexes are available concurrently, even with the same provider/model.
    call(
        &db,
        json!({"op":"claim","job_id":"job:auto:task:feature-0"}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"claim","job_id":"job:auto:task:feature-1"}),
    )
    .unwrap();
    call(&db,json!({"op":"fail","job_id":"job:auto:task:feature-0","epoch":1,"error":"Simulated failure","retryable":false})).unwrap();
    let failed = snapshot(&db);
    assert_eq!(
        failed["team_tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["task_id"] == "feature-2")
            .unwrap()["status"],
        "queued",
        "terminal failure immediately wakes independent same-index task"
    );
    assert_eq!(
        failed["team_tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["task_id"] == "integrate")
            .unwrap()["status"],
        "blocked",
        "failed source dependency still blocks integration"
    );
    call(&db,json!({"op":"finish","job_id":"job:auto:task:feature-1","epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap();
    call(
        &db,
        json!({"op":"claim","job_id":"capture:auto:task:feature-1"}),
    )
    .unwrap();
    call(&db,json!({"op":"finish","job_id":"capture:auto:task:feature-1","epoch":1,"result":{"id":"captured-parallel","revision":{"repository":"test/parallel","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/feature-1.js"],"summary":"Independent task captured","diff":"x"}})).unwrap();
    let s = snapshot(&db);
    assert_eq!(
        s["team_tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["task_id"] == "feature-2")
            .unwrap()["status"],
        "queued"
    );
    let retry = json!({"op":"retry_team_task","run_id":"auto","task_id":"feature-0","expected_epoch":1,"expected_revision":1});
    assert_eq!(call(&db, retry).unwrap_err().code, "AGENT_BUSY");
    assert_eq!(
        snapshot(&db)["team_tasks"],
        s["team_tasks"],
        "busy retry rolls back before changing attempts"
    );
}
