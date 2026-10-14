use super::*;
use crate::{native::NativeStore, source_workspace};
use yoneda_core::source_workspace::{SourceRevision, SourceView};
const KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    if c.get("now").is_none() {
        c["now"] = json!(16000);
    }
    c["_workspace"] = json!("owner");
    crate::execute(db, c)
}
fn budget(model: &str) -> Value {
    json!({"provider":"zai","model":model,"max_requests":144,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":50000000,"pricing":{"input_microusd_per_million":100000,"output_microusd_per_million":200000,"source":"owner-approved conservative rates"}})
}
fn fixture() -> (NativeStore, Value) {
    fixture_with_two_seals(false)
}
fn fixture_with_two_seals(both: bool) -> (NativeStore, Value) {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"init","now":1000,"workspace":"owner","id":"repo","name":"Recovery","remote":{"namespace":"test","name":"retry"},"commit":"a".repeat(40),"policy":{"version":"retry-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}})).unwrap();
    call(&db,json!({"op":"create_working_branch","now":1000,"id":"branch","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    call(&db,json!({"op":"start_run","now":1000,"id":"retry","intent":"Recover original approved source","mode":"compare","comparison":{"version":1},"agents":[{"provider":"zai","model":"glm-5.3-flash","connection":"zai","strategy":"first"},{"provider":"zai","model":"glm-4.7-flash","connection":"zai","strategy":"second"}],"_comparison_reviewer":{"provider":"zai","model":"glm-5.3-flash","connection":"zai"},"_comparison_reviewer_budget":budget("glm-5.3-flash"),"model_budgets":[budget("glm-5.3-flash"),budget("glm-4.7-flash")],"working_branch_id":"branch","expected_working_commit":"a".repeat(40),"expected_working_version":0,"workspace_transport":"api-source-v1","_source_transport_approved":true,"_source_base":{"repository":"test/retry","commit":"a".repeat(40),"tree":"b".repeat(40)}})).unwrap();
    let invoke = |mut c: Value, now: i64| {
        c["now"] = json!(now);
        c["_workspace"] = json!("owner");
        crate::execute(&db, c)
    };
    let other = invoke(json!({"op":"claim","job_id":"job:retry:agent-2"}), 10000).unwrap();
    if !both {
        invoke(json!({"op":"fail","job_id":other["id"],"epoch":other["epoch"],"retryable":false,"error":"Other source fixture failed"}),10000).unwrap();
    }
    invoke(json!({"op":"claim","job_id":"job:retry:agent-1"}), 10000).unwrap();
    invoke(json!({"op":"defer_job","job_id":"job:retry:agent-1","epoch":1,"reason":"source_preparing"}),10000).unwrap();
    invoke(json!({"op":"claim","job_id":"job:retry:agent-1"}), 15000).unwrap();
    let registration = seal_and_finish(&db, "job:retry:agent-1", 3);
    if both {
        seal_and_finish(&db, "job:retry:agent-2", 1);
    }
    for capture_id in ["capture:retry:agent-1", "capture:retry:agent-2"] {
        if !both && capture_id.ends_with("agent-2") {
            continue;
        }
        for attempt in [1, 2] {
            let j = invoke(json!({"op":"claim","job_id":capture_id}), 15000).unwrap();
            invoke(json!({"op":"fail","job_id":j["id"],"epoch":j["epoch"],"retryable":attempt==1,"error":"Native capture provenance fixture failed"}),15000).unwrap();
        }
    }
    // Historical R12 review is already terminal, with its original immutable usage retained.
    for mut j in run_jobs(&db, "retry").unwrap() {
        if j["status"] == "queued" || j["status"] == "running" {
            j["status"] = json!("done");
            save(&db, "jobs", &string(&j, "id").unwrap(), &j).unwrap();
        }
    }
    let mut run = get(&db, "runs", "retry").unwrap();
    run["status"] = json!("ready");
    run["comparison"]["status"] = json!("needs_attention");
    run["comparison"]["review_requests_by_round"] = json!([9, 0, 0]);
    run["model_requests"] = json!(48);
    run["model_budgets"][0]["requests"] = json!(24);
    run["model_budgets"][1]["requests"] = json!(24);
    run["model_budgets"][0]["charged_microusd"] = json!(1234);
    let review = json!({"id":"old-review","run_id":"retry","outcome":"needs_attention","rationale":"Historical failed capture","manifest_digest":"c".repeat(64)});
    node(
        &db,
        "old-review",
        "proposed_decision",
        "Old review",
        "agent_assertion",
        15000,
        review.clone(),
    )
    .unwrap();
    run["comparison"]["latest_review_id"] = json!("old-review");
    run["comparison"]["latest_review"] = review;
    save(&db, "runs", "retry", &run).unwrap();
    let request = json!({"op":"retry_capture","request_id":"recover","capture_job_id":"capture:retry:agent-1","expected_producer_epoch":3,"expected_registration_id":registration["registration_id"],"expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_digest":registration["binding"]["policy_digest"]});
    (db, request)
}
fn seal_and_finish(db: &NativeStore, job_id: &str, epoch: i64) -> Value {
    let view = SourceView {
        version: 1,
        base: SourceRevision {
            repository: "test/retry".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
        },
        files: vec![],
    };
    let bound=call(db, json!({"op":"source_bind","now":15000,"job_id":job_id,"epoch":epoch,"_source_view":view,"_supervisor":true,"_source_signing_key":KEY})).unwrap();
    let source = NativeStore::memory().unwrap();
    let sc = |mut c: Value| {
        c["now"] = json!(15000);
        c["_actor"] = bound["actor_grant"].clone();
        c["_source_signing_key"] = json!(KEY);
        source_workspace::execute_source_workspace(&source, c)
    };
    sc(json!({"op":"source_init","request_id":"init","binding":bound["binding"],"view":view,"baseline_overrides":[]})).unwrap();
    let checkpoint = sc(
        json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":0}),
    )
    .unwrap();
    let seal=sc(json!({"op":"source_seal","request_id":"seal","expected_workspace_version":0,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]})).unwrap();
    let registration=call(db, json!({"op":"source_register_changeset","now":15000,"request_id":"register","job_id":job_id,"epoch":epoch,"view_digest":bound["binding"]["view_digest"],"_source_seal":seal,"_source_signing_key":KEY})).unwrap();
    call(db, json!({"op":"finish","now":15000,"job_id":job_id,"epoch":epoch,"result":{"source_verified":true,"source_registered":{"producer_job_id":job_id,"producer_epoch":epoch,"registration_id":registration["registration_id"],"changeset_digest":registration["changeset_digest"]}}})).unwrap();
    registration
}
#[test]
fn same_seal_capture_retry_is_one_shot_and_preserves_approvals_usage_and_old_review() {
    let (db, request) = fixture();
    let before = get(&db, "runs", "retry").unwrap();
    let old = get(&db, "jobs", "capture:retry:agent-1").unwrap();
    let producer = get(&db, "jobs", "job:retry:agent-1").unwrap();
    let review = get(&db, "nodes", "old-review").unwrap();
    let receipt = call(&db, request.clone()).unwrap();
    let after = get(&db, "runs", "retry").unwrap();
    for k in [
        "model_budgets",
        "model_requests",
        "execution_count",
        "agents",
        "policy",
        "base",
        "workspace_spend",
    ] {
        assert_eq!(after[k], before[k]);
    }
    for k in [
        "approval",
        "round",
        "review_requests_by_round",
        "model_requests",
        "model_budgets",
    ] {
        assert_eq!(after["comparison"][k], before["comparison"][k]);
    }
    assert_eq!(after["comparison"]["status"], "building");
    assert_eq!(
        after["comparison"]["verification_recovery"]["automatic_review"],
        false
    );
    assert!(after["comparison"]["latest_review_id"].is_null());
    assert_eq!(get(&db, "nodes", "old-review").unwrap(), review);
    assert_eq!(get(&db, "jobs", "job:retry:agent-1").unwrap(), producer);
    assert_eq!(
        get(&db, "jobs", "capture:retry:agent-1").unwrap()["attempt"],
        old["attempt"]
    );
    let job = get(&db, "jobs", receipt["job_id"].as_str().unwrap()).unwrap();
    assert_eq!(job["kind"], "capture");
    assert_eq!(job["payload"]["execution"]["epoch"], 3);
    assert_eq!(
        job["payload"]["source_registered"],
        old["payload"]["source_registered"]
    );
    assert!(job.get("source_capture_ref").is_none());
    assert_eq!(call(&db, request.clone()).unwrap(), receipt);
    let mut changed = request.clone();
    changed["expected_producer_epoch"] = json!(4);
    assert_eq!(call(&db, changed).unwrap_err().code, "IDEMPOTENCY_CONFLICT");
    let mut second = request;
    second["request_id"] = json!("again");
    assert_eq!(call(&db, second).unwrap_err().code, "RESOURCE_LIMIT");
    assert!(
        run_jobs(&db, "retry")
            .unwrap()
            .iter()
            .filter(|j| j["status"] == "queued")
            .all(|j| j["kind"] == "capture")
    );
}
#[test]
fn capture_recovery_rejects_forged_or_stale_authority_atomically() {
    for case in [
        "workspace",
        "grant",
        "producer_epoch",
        "registration",
        "producer_changed",
        "branch",
        "policy",
        "cancelled",
        "active",
        "child",
        "candidate",
        "publish",
        "team",
    ] {
        let (db, mut request) = fixture();
        match case {
            "workspace" => request["_workspace"] = json!("other"),
            "grant" => request["_grant"] = json!("forged"),
            "producer_epoch" => request["expected_producer_epoch"] = json!(4),
            "registration" => request["expected_registration_id"] = json!("forged"),
            "producer_changed" => {
                let mut p = get(&db, "jobs", "job:retry:agent-1").unwrap();
                p["epoch"] = json!(4);
                save(&db, "jobs", "job:retry:agent-1", &p).unwrap();
            }
            "branch" => {
                let mut b = get(&db, "working_branches", "branch").unwrap();
                b["version"] = json!(1);
                save(&db, "working_branches", "branch", &b).unwrap();
            }
            "policy" => request["expected_policy_digest"] = json!("0".repeat(64)),
            "cancelled" => {
                let mut r = get(&db, "runs", "retry").unwrap();
                r["status"] = json!("cancelled");
                save(&db, "runs", "retry", &r).unwrap();
            }
            "active" => job(
                &db,
                "model-active",
                "agent",
                16000,
                json!({"execution":{"id":"retry:agent-2","run_id":"retry"},"run_id":"retry"}),
            )
            .unwrap(),
            "child" => save(
                &db,
                "executions",
                "child",
                &json!({"id":"child","run_id":"retry","parent_execution":"retry:agent-1"}),
            )
            .unwrap(),
            "candidate" => save(
                &db,
                "candidates",
                "existing",
                &json!({"id":"existing","run_id":"retry","execution":"retry:agent-1"}),
            )
            .unwrap(),
            "publish" => {
                let mut r = repo(&db).unwrap();
                r["pending"] = json!("publication");
                save(&db, "repository", "repo", &r).unwrap();
            }
            "team" => {
                let mut e = get(&db, "executions", "retry:agent-1").unwrap();
                e["team_task"] = json!("task");
                save(&db, "executions", "retry:agent-1", &e).unwrap();
            }
            _ => unreachable!(),
        }
        let jobs = all(&db, "jobs").unwrap();
        let executions = all(&db, "executions").unwrap();
        let before = get(&db, "runs", "retry").unwrap();
        request["now"] = json!(16000);
        request["_workspace"] = request.get("_workspace").cloned().unwrap_or(json!("owner"));
        let error = crate::execute(&db, request).unwrap_err();
        assert!(
            matches!(
                error.code.as_str(),
                "FORBIDDEN"
                    | "SOURCE_CHANGED"
                    | "HEAD_MOVED"
                    | "POLICY_CHANGED"
                    | "FENCED"
                    | "AGENT_BUSY"
            ),
            "{case}: {}",
            error.code
        );
        assert_eq!(all(&db, "jobs").unwrap(), jobs, "{case}");
        assert_eq!(all(&db, "executions").unwrap(), executions, "{case}");
        assert_eq!(get(&db, "runs", "retry").unwrap(), before, "{case}");
    }
}
#[test]
fn retry_capture_recaptures_registered_epoch_three_and_queues_only_fresh_checks() {
    let (db, request) = fixture();
    let before = get(&db, "runs", "retry").unwrap();
    let receipt = call(&db, request).unwrap();
    capture_and_check(&db, &receipt, "recovered", "c", 3);
    let after = get(&db, "runs", "retry").unwrap();
    assert_eq!(after["comparison"]["status"], "needs_attention");
    assert_eq!(
        after["comparison"]["review_skip_reason"]["code"],
        "CAPTURE_RECOVERY_CHECK_ONLY"
    );
    assert_eq!(after["model_requests"], 48);
    assert_eq!(after["model_budgets"], before["model_budgets"]);
    assert_eq!(
        after["comparison"]["review_requests_by_round"],
        json!([9, 0, 0])
    );
    assert_eq!(after["execution_count"], before["execution_count"]);
    assert_eq!(
        get(&db, "candidates", "recovered").unwrap()["status"],
        "eligible"
    );
    assert!(
        run_jobs(&db, "retry")
            .unwrap()
            .iter()
            .all(|j| j["status"] != "queued" && j["status"] != "running")
    );
}

fn capture_and_check(
    db: &NativeStore,
    receipt: &Value,
    candidate_id: &str,
    commit: &str,
    producer_epoch: i64,
) {
    let id = receipt["job_id"].as_str().unwrap();
    let producer_job = get(db, "jobs", id).unwrap();
    let producer_id = producer_job["payload"]["source_registered"]["producer_job_id"]
        .as_str()
        .unwrap();
    let captured = call(db, json!({"op":"claim","job_id":id})).unwrap();
    let mut context = json!({"op":"source_capture_context","job_id":id,"epoch":captured["epoch"],"_source_signing_key":KEY});
    context["now"] = json!(16000);
    let context = call(db, context).unwrap();
    assert_eq!(context["binding"]["epoch"], producer_epoch);
    assert_eq!(context["_capture_grant"]["claims"]["capture_job_id"], id);
    let registration =
        get(db, "jobs", producer_id).unwrap()["source_registered"]["registration"].clone();
    let b = &registration["binding"];
    let lineage = json!({"version":1,"authority":"registered_source_changeset","workspace_id":b["workspace_id"],"registration_id":registration["registration_id"],"producer_job_id":producer_id,"producer_epoch":producer_epoch,"seal_id":registration["seal_id"],"checkpoint_id":registration["checkpoint_id"],"changeset_digest":registration["changeset_digest"],"view_digest":b["view_digest"],"baseline_overrides_digest":b["baseline_overrides_digest"]});
    let result = json!({"id":candidate_id,"revision":{"repository":"test/recovered","commit":commit.repeat(40)},"tree":"b".repeat(40),"parents":b["parents"],"paths":[],"summary":"Same registered source recaptured","source_verified":true,"source_lineage":lineage,"source_changeset_digest":registration["changeset_digest"],"source_manifest_digest":registration["changeset_digest"],"file_provenance":[]});
    call(
        db,
        json!({"op":"finish","job_id":id,"epoch":captured["epoch"],"result":result}),
    )
    .unwrap();
    assert_eq!(
        get(db, "jobs", &format!("evaluate:{candidate_id}")).unwrap()["status"],
        "queued"
    );
    let candidate = get(db, "candidates", candidate_id).unwrap();
    let evaluator = call(
        db,
        json!({"op":"claim","job_id":format!("evaluate:{candidate_id}")}),
    )
    .unwrap();
    let p = repo(db).unwrap()["policy"].clone();
    call(db,json!({"op":"finish","job_id":format!("evaluate:{candidate_id}"),"epoch":evaluator["epoch"],"result":{"id":format!("{candidate_id}-check"),"candidate":candidate_id,"revision":candidate["revision"],"policy":p["version"],"suite":p["suite"],"environment":p["environment"],"evidence":"f".repeat(64),"checks":[{"name":"build","status":"pass","detail":"Fresh independent fixture check"}]}})).unwrap();
}

#[test]
fn two_registered_builders_recover_sequentially_without_paid_review_or_counter_reset() {
    let (db, request) = fixture_with_two_seals(true);
    let before = get(&db, "runs", "retry").unwrap();
    let branch = get(&db, "working_branches", "branch").unwrap();
    let producers = [
        get(&db, "jobs", "job:retry:agent-1").unwrap(),
        get(&db, "jobs", "job:retry:agent-2").unwrap(),
    ];
    let first = call(&db, request.clone()).unwrap();
    let mut second_request = request;
    second_request["request_id"] = json!("recover-second");
    second_request["capture_job_id"] = json!("capture:retry:agent-2");
    second_request["expected_producer_epoch"] = json!(1);
    second_request["expected_registration_id"] =
        producers[1]["source_registered"]["registration"]["registration_id"].clone();
    let jobs = all(&db, "jobs").unwrap();
    assert_eq!(
        call(&db, second_request.clone()).unwrap_err().code,
        "AGENT_BUSY"
    );
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    capture_and_check(&db, &first, "recovered-first", "c", 3);
    let ready = get(&db, "runs", "retry").unwrap();
    assert_eq!(ready["status"], "ready");
    assert_eq!(ready["comparison"]["status"], "needs_attention");
    assert_eq!(
        ready["comparison"]["review_skip_reason"]["code"],
        "CAPTURE_RECOVERY_CHECK_ONLY"
    );
    assert_eq!(
        all(&db, "candidates")
            .unwrap()
            .iter()
            .filter(|c| c["status"] == "eligible")
            .count(),
        1
    );
    let second = call(&db, second_request.clone()).unwrap();
    capture_and_check(&db, &second, "recovered-second", "d", 1);
    assert_eq!(call(&db, second_request).unwrap(), second);
    let after = get(&db, "runs", "retry").unwrap();
    assert_eq!(after["status"], "ready");
    assert_eq!(after["comparison"]["status"], "needs_attention");
    assert_eq!(
        after["comparison"]["review_skip_reason"]["code"],
        "CAPTURE_RECOVERY_CHECK_ONLY"
    );
    assert!(after["comparison"]["selected_candidate_id"].is_null());
    assert_eq!(
        all(&db, "candidates")
            .unwrap()
            .iter()
            .filter(|c| c["status"] == "eligible")
            .count(),
        2
    );
    for k in [
        "agents",
        "policy",
        "base",
        "model_budgets",
        "model_requests",
        "execution_count",
        "workspace_spend",
    ] {
        assert_eq!(after[k], before[k], "{k}");
    }
    for k in [
        "approval",
        "round",
        "review_requests_by_round",
        "model_budgets",
        "model_requests",
    ] {
        assert_eq!(after["comparison"][k], before["comparison"][k], "{k}");
    }
    assert_eq!(get(&db, "working_branches", "branch").unwrap(), branch);
    for (i, producer) in producers.iter().enumerate() {
        assert_eq!(
            get(&db, "jobs", &format!("job:retry:agent-{}", i + 1)).unwrap(),
            *producer
        );
        assert_eq!(
            get(&db, "jobs", &format!("capture:retry:agent-{}", i + 1)).unwrap()["attempt"],
            2
        );
    }
    let jobs = run_jobs(&db, "retry").unwrap();
    assert_eq!(jobs.iter().filter(|j| j["kind"] == "agent").count(), 2);
    assert!(
        jobs.iter()
            .all(|j| j["status"] != "queued" && j["status"] != "running")
    );
}
