use super::*;

fn coding_repo() -> NativeStore {
    repo_with_policy(json!({"version":"site-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}))
}
fn run(db: &NativeStore, roots: usize, enabled: bool, max_executions: usize) -> Value {
    let agents: Vec<_> = (1..=roots)
        .map(|i| {
            json!({"provider":"mimo","connection":"personal",
        "model":"mimo-v2.6-flash","strategy":format!("approach-{i}")})
        })
        .collect();
    call(db,json!({"op":"start_run","id":"scale","intent":"Build a useful website",
        "agents":agents,"delegation":{"enabled":enabled,"max_depth":if enabled {2} else {0},"max_executions":max_executions}})).unwrap()
}
fn claim(db: &NativeStore, job: &str) -> Value {
    call(db, json!({"op":"claim","job_id":job})).unwrap()
}
fn delegate(db: &NativeStore, job: &str, epoch: i64, request: &str) -> Result<Value> {
    call(
        db,
        json!({"op":"delegate_agent","job_id":job,"epoch":epoch,"request_id":request,
        "task":"Produce an accessible independent alternative","strategy":"accessibility"}),
    )
}
fn cancel(db: &NativeStore) -> Value {
    call(db, json!({"op":"cancel_run","run_id":"scale"})).unwrap()
}

#[test]
fn six_roots_are_independent_and_invalid_seventh_rolls_back() {
    let db = coding_repo();
    run(&db, 6, true, 12);
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(s["executions"].as_array().unwrap().len(), 6);
    assert_eq!(s["capabilities"]["agent_limits"]["max_root_agents"], 6);
    assert_eq!(s["executions"][0]["base"], s["executions"][5]["base"]);
    let agents: Vec<_> = (0..7)
        .map(|i| json!({"provider":"mimo","model":"flash","strategy":i.to_string()}))
        .collect();
    assert_eq!(
        call(
            &db,
            json!({"op":"start_run","id":"bad","intent":"Too many","agents":agents})
        )
        .unwrap_err()
        .code,
        "INVALID_INPUT"
    );
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn delegation_is_opt_in_and_replays_do_not_spend_execution_slots() {
    let disabled = coding_repo();
    run(&disabled, 2, false, 2);
    claim(&disabled, "job:scale:agent-1");
    assert_eq!(
        delegate(&disabled, "job:scale:agent-1", 1, "access")
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
    let db = coding_repo();
    let frozen = run(&db, 2, true, 3);
    claim(&db, "job:scale:agent-1");
    let child = delegate(&db, "job:scale:agent-1", 1, "access").unwrap();
    let replay = delegate(&db, "job:scale:agent-1", 1, "access").unwrap();
    assert_eq!(child["execution"], replay["execution"]);
    assert_eq!(replay["replayed"], true);
    assert_eq!(child["execution"]["provider"], "mimo");
    assert_eq!(child["execution"]["connection"], "personal");
    assert_eq!(child["execution"]["model"], "mimo-v2.6-flash");
    assert_eq!(child["execution"]["base"], frozen["base"]);
    assert_eq!(child["execution"]["parent_epoch"], 1);
    assert_eq!(
        delegate(&db, "job:scale:agent-1", 1, "other")
            .unwrap_err()
            .code,
        "RESOURCE_LIMIT"
    );
    assert_eq!(call(&db,json!({"op":"delegate_agent","job_id":"job:scale:agent-1","epoch":1,"request_id":"access","task":"Conflicting brief","strategy":"accessibility"})).unwrap_err().code,"IDEMPOTENCY_CONFLICT");
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(s["runs"][0]["execution_count"], 3);
    assert_eq!(s["executions"].as_array().unwrap().len(), 3);
    assert!(
        s["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["relation"] == "delegates_to")
    );
}

#[test]
fn depth_and_attempt_ancestry_are_fenced_without_waiting_for_recovery() {
    let db = coding_repo();
    run(&db, 2, true, 12);
    claim(&db, "job:scale:agent-1");
    let child = delegate(&db, "job:scale:agent-1", 1, "first").unwrap();
    let child_job = child["job_id"].as_str().unwrap();
    claim(&db, child_job);
    let grandchild = delegate(&db, child_job, 1, "second").unwrap();
    let grandchild_job = grandchild["job_id"].as_str().unwrap();
    claim(&db, grandchild_job);
    assert_eq!(
        delegate(&db, grandchild_job, 1, "too-deep")
            .unwrap_err()
            .code,
        "RESOURCE_LIMIT"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"context","job_id":child_job,"epoch":1,"now":122000})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    call(&db,json!({"op":"fail","job_id":"job:scale:agent-1","epoch":1,"retryable":true,"error":"Restart"})).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"context","job_id":grandchild_job,"epoch":1})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    assert_eq!(claim(&db, "job:scale:agent-1")["epoch"], 2);
    assert_eq!(
        delegate(&db, "job:scale:agent-1", 2, "first")
            .unwrap_err()
            .code,
        "FENCED"
    );
    assert!(delegate(&db, "job:scale:agent-1", 2, "new-attempt").is_ok());
    let stops = call(&db, json!({"op":"outbox"})).unwrap();
    assert!(
        stops["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["kind"] == "stop")
    );
}

#[test]
fn completed_parent_allows_issued_child_to_finish_and_status_is_scoped() {
    let db = coding_repo();
    run(&db, 2, true, 12);
    claim(&db, "job:scale:agent-1");
    claim(&db, "job:scale:agent-2");
    let child = delegate(&db, "job:scale:agent-1", 1, "first").unwrap();
    let outsider = delegate(&db, "job:scale:agent-2", 1, "other").unwrap();
    let child_job = child["job_id"].as_str().unwrap();
    claim(&db, child_job);
    call(
        &db,
        json!({"op":"context_publish","job_id":child_job,"epoch":1,
        "record":{"id":"finding:child","kind":"finding","statement":"Use accessible controls",
        "purpose":"Keep keyboard navigation","intent_id":"intent:scale","links":[]}}),
    )
    .unwrap();
    let status = call(
        &db,
        json!({"op":"delegation_status","job_id":"job:scale:agent-1","epoch":1}),
    )
    .unwrap();
    assert_eq!(status["children"].as_array().unwrap().len(), 1);
    assert_ne!(status["children"][0]["id"], outsider["execution"]["id"]);
    assert_eq!(status["context"][0]["id"], "finding:child");
    call(&db,json!({"op":"finish","job_id":"job:scale:agent-1","epoch":1,"result":{"workspace":"e".repeat(64)}})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":child_job,"epoch":1,"result":{"workspace":"e".repeat(64)}}),
    )
    .unwrap();
    assert!(call(&db,json!({"op":"claim","job_id":format!("capture:{}",child["execution"]["id"].as_str().unwrap())})).is_ok());
}

#[test]
fn aggregate_model_budget_survives_retries_and_blocks_children_atomically() {
    let db = coding_repo();
    run(&db, 6, true, 12);
    db.query(
        "UPDATE runs SET payload=json_remove(payload,'$.model_budgets','$.request_limits')",
        &[],
    )
    .unwrap();
    claim(&db, "job:scale:agent-1");
    let child = delegate(&db, "job:scale:agent-1", 1, "first").unwrap();
    for i in 1..=6 {
        let job = format!("job:scale:agent-{i}");
        if i > 1 {
            claim(&db, &job);
        }
        for request in 1..=24 {
            let v = call(
                &db,
                json!({"op":"reserve_request","job_id":job,"epoch":1,"kind":"model"}),
            )
            .unwrap();
            assert_eq!(v["run_number"], (i - 1) * 24 + request);
        }
    }
    let child_job = child["job_id"].as_str().unwrap();
    claim(&db, child_job);
    assert_eq!(
        call(
            &db,
            json!({"op":"reserve_request","job_id":child_job,"epoch":1,"kind":"model"})
        )
        .unwrap_err()
        .code,
        "RESOURCE_LIMIT"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"delegation_status","job_id":child_job,"epoch":1})
        )
        .unwrap()["model_requests"],
        144
    );
    call(&db,json!({"op":"fail","job_id":"job:scale:agent-6","epoch":1,"retryable":true,"error":"Retry"})).unwrap();
    claim(&db, "job:scale:agent-6");
    assert_eq!(
        call(
            &db,
            json!({"op":"reserve_request","job_id":"job:scale:agent-6","epoch":2,"kind":"model"})
        )
        .unwrap_err()
        .code,
        "RESOURCE_LIMIT"
    );
}

#[test]
fn run_cancel_fences_child_capture_and_historical_eligible_candidates() {
    let db = coding_repo();
    run(&db, 2, true, 12);
    claim(&db, "job:scale:agent-1");
    let child = delegate(&db, "job:scale:agent-1", 1, "first").unwrap();
    let child_job = child["job_id"].as_str().unwrap();
    claim(&db, child_job);
    call(
        &db,
        json!({"op":"finish","job_id":child_job,"epoch":1,"result":{"workspace":"e".repeat(64)}}),
    )
    .unwrap();
    let capture = format!("capture:{}", child["execution"]["id"].as_str().unwrap());
    claim(&db, &capture);
    call(
        &db,
        json!({"op":"finish","job_id":capture,"epoch":1,"result":{"id":"child-candidate",
        "revision":{"repository":"test/fork","commit":"c".repeat(40)},"tree":"d".repeat(40),
        "paths":["index.html"],"summary":"Accessible site","diff":"html"}}),
    )
    .unwrap();
    claim(&db, "evaluate:child-candidate");
    call(
        &db,
        json!({"op":"verify_finish","job_id":"evaluate:child-candidate","epoch":1,
        "report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],
        "commands":[{"name":"build","output":{"exit":0}}]},"evidence":"e".repeat(64)}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["candidates"][0]["status"],
        "eligible"
    );
    cancel(&db);
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(s["candidates"][0]["status"], "cancelled");
    assert!(
        s["executions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["status"] == "cancelled")
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"context","job_id":"job:scale:agent-1","epoch":1})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
}

#[test]
fn review_regression_recovery_cannot_revive_a_child_fenced_earlier_in_the_pass() {
    let db = coding_repo();
    run(&db, 2, true, 12);
    claim(&db, "job:scale:agent-1");
    let child = delegate(&db, "job:scale:agent-1", 1, "first").unwrap();
    let child_job = child["job_id"].as_str().unwrap();
    claim(&db, child_job);
    let recovered = call(&db, json!({"op":"recover","now":122000})).unwrap();
    let stored = crate::storage::get(&db, "jobs", child_job).unwrap();
    assert_eq!(stored["status"], "cancelled");
    assert_eq!(stored["epoch"], 2);
    assert_eq!(recovered["recovered"], 1);
    assert!(
        db.query(
            "SELECT id FROM outbox WHERE id=?",
            &[json!(format!("dispatch:{child_job}:1"))]
        )
        .unwrap()
        .is_empty()
    );
    assert_eq!(
        call(&db, json!({"op":"claim","job_id":child_job,"now":122000}))
            .unwrap_err()
            .code,
        "FENCED"
    );
}

#[test]
fn accepted_child_publication_survives_parent_failure_without_agent_authority() {
    accepted_child_publication(false);
}

#[test]
fn queued_accepted_child_publication_survives_parent_expiry_and_restart() {
    accepted_child_publication(true);
}

fn accepted_child_publication(queued: bool) {
    let db = coding_repo();
    run(&db, 2, true, 12);
    claim(&db, "job:scale:agent-1");
    let child = delegate(&db, "job:scale:agent-1", 1, "publish").unwrap();
    let child_job = child["job_id"].as_str().unwrap();
    claim(&db, child_job);
    call(
        &db,
        json!({"op":"finish","job_id":child_job,"epoch":1,"result":{"workspace":"e".repeat(64)}}),
    )
    .unwrap();
    let capture = format!("capture:{}", child["execution"]["id"].as_str().unwrap());
    claim(&db, &capture);
    call(
        &db,
        json!({"op":"finish","job_id":capture,"epoch":1,"result":{"id":"publication-candidate",
        "revision":{"repository":"test/fork","commit":"c".repeat(40)},"tree":"d".repeat(40),
        "paths":["index.html"],"summary":"Checked child website","diff":"html"}}),
    )
    .unwrap();
    claim(&db, "evaluate:publication-candidate");
    call(
        &db,
        json!({"op":"verify_finish","job_id":"evaluate:publication-candidate","epoch":1,
        "report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],
        "commands":[{"name":"build","output":{"exit":0}}]},"evidence":"e".repeat(64)}),
    )
    .unwrap();
    call(&db,json!({"op":"accept","request_id":"child-publication","candidate":"publication-candidate",
        "expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Choose checked alternative"})).unwrap();
    let publisher = "publish:decision:child-publication";
    if queued {
        call(&db, json!({"op":"recover","now":122000})).unwrap();
        call(
            &db,
            json!({"op":"claim","job_id":"job:scale:agent-1","now":122000}),
        )
        .unwrap();
        assert_eq!(
            call(&db, json!({"op":"claim","job_id":publisher,"now":122001})).unwrap()["epoch"],
            1
        );
    } else {
        claim(&db, publisher);
        call(&db,json!({"op":"fail","job_id":"job:scale:agent-1","epoch":1,"retryable":false,"error":"Parent failed","now":2000})).unwrap();
    }
    let now = if queued { 122002 } else { 2001 };
    call(
        &db,
        json!({"op":"check_attempt","job_id":publisher,"epoch":1,"now":now}),
    )
    .unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"context","job_id":child_job,"epoch":1,"now":now})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"context","job_id":publisher,"epoch":1,"now":now})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    call(
        &db,
        json!({"op":"finish","job_id":publisher,"epoch":1,"now":now,"result":{"commit":"c".repeat(40)}}),
    )
    .unwrap();
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    let decision = &snapshot["decisions"][0];
    let graph_decision = snapshot["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["id"] == decision["id"])
        .unwrap();
    assert_eq!(decision["status"], "published");
    assert_eq!(graph_decision["data"], *decision);
    assert_eq!(snapshot["repository"]["status"], "ready");
    assert_eq!(snapshot["repository"]["published_commit"], "c".repeat(40));
    assert_eq!(snapshot["candidates"][0]["status"], "eligible");
}
