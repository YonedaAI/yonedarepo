use super::*;
use crate::native::NativeStore;

const BASE: &str = "yoneda-dev/sandbox";

fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    if c.get("now").is_none() {
        c["now"] = json!(1000);
    }
    crate::execute(db, c)
}

fn repository() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let policy = json!({"version":"sandbox-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","src/math.js"],"timeout_seconds":30}]}});
    call(&db, json!({"op":"init","id":"sandbox","name":"Sandbox","remote":{"namespace":"yoneda-dev","name":"sandbox"},"commit":"a".repeat(40),"policy":policy})).unwrap();
    db
}

fn start(agents: Value, extra: Value) -> Value {
    let mut c = json!({"op":"start_run","id":"run-s","intent":"Add add(a,b) in src/math.js with a test",
        "agents":agents,"workspace_transport":TRANSPORT,"_source_transport_approved":true,
        "_source_base":{"repository":BASE,"commit":"a".repeat(40),"tree":"b".repeat(40)}});
    for (key, value) in extra.as_object().unwrap() {
        c[key] = value.clone();
    }
    c
}

fn glm() -> Value {
    json!([{"provider":"zai","model":"glm-5.3-flash","strategy":"minimal"}])
}

fn two() -> Value {
    json!([glm()[0], {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"other"}])
}

fn claimed(db: &NativeStore) -> Value {
    call(db, start(glm(), json!({}))).unwrap();
    call(db, json!({"op":"claim","job_id":"job:run-s:agent-1"})).unwrap()
}

#[test]
fn a_compare_run_takes_one_sandbox_per_agent() {
    let db = repository();
    let run = call(&db, start(two(), json!({}))).unwrap();
    assert_eq!(run["runtime"], TRANSPORT);
    assert_eq!(run["mode"], "compare");
    // A sandbox run carries its own transport tag, not the lazy-source one.
    assert_eq!(run["workspace_transport"], TRANSPORT);
    assert!(
        run["comparison"].is_null(),
        "no reviewer: the owner chooses"
    );
    for n in 1..=2 {
        let execution = get(&db, "executions", &format!("run-s:agent-{n}")).unwrap();
        assert_eq!(execution["runtime"], TRANSPORT);
        let job = call(
            &db,
            json!({"op":"claim","job_id":format!("job:run-s:agent-{n}")}),
        )
        .unwrap();
        assert_eq!(job["sandbox"], true);
        assert_eq!(job["lease_until"], 1000 + LEASE_MS);
    }
}

#[test]
fn team_delegation_and_reviewer_runs_are_refused() {
    let db = repository();
    let refused = |agents: Value, extra: Value| call(&db, start(agents, extra)).unwrap_err().code;
    assert_eq!(
        refused(glm(), json!({"mode":"collaborate"})),
        "NOT_SUPPORTED"
    );
    // A reviewer request is refused before it reaches the guard; the guard refuses it too.
    assert!(call(&db, start(two(), json!({"comparison":{"version":1}}))).is_err());
    let mut run = json!({});
    let reviewed = freeze(
        &json!({"agents":two(),"comparison":{"version":1}}),
        false,
        &DelegationPolicy::disabled(2),
        &mut run,
    );
    assert_eq!(reviewed.unwrap_err().code, "NOT_SUPPORTED");
    assert!(run["runtime"].is_null());
    let delegation = json!({"enabled":true,"max_depth":1,"max_executions":3});
    assert_eq!(
        refused(two(), json!({"delegation":delegation})),
        "NOT_SUPPORTED"
    );
    let seven: Vec<Value> = (0..7)
        .map(|n| json!({"provider":"zai","model":"glm-5.3-flash","strategy":format!("s{n}")}))
        .collect();
    assert_eq!(refused(json!(seven), json!({})), "INVALID_INPUT");
}

/// Records agent `n`'s pushed commit and passes its check; returns the candidate id.
fn eligible(db: &NativeStore, n: usize, commit: char) -> String {
    let job = call(
        db,
        json!({"op":"claim","job_id":format!("job:run-s:agent-{n}")}),
    )
    .unwrap();
    let id = format!("sandbox-candidate-{n}");
    call(
        db,
        json!({"op":"sandbox_finish","job_id":job["id"],"epoch":job["epoch"],
        "result":{"id":id,"revision":{"repository":BASE,"commit":commit.to_string().repeat(40)},
        "parents":["a".repeat(40)],"tree":"d".repeat(40),"paths":["src/math.js"],
        "summary":"Added add(a,b)","diff_digest":"e".repeat(64)}}),
    )
    .unwrap();
    let check = call(db, json!({"op":"claim","job_id":format!("evaluate:{id}")})).unwrap();
    assert_eq!(check["sandbox_check"], true);
    verify(db, &check, check_report(json!(0))).unwrap();
    id
}

#[test]
fn the_owner_publishes_one_of_several_checked_sandbox_candidates() {
    let db = repository();
    call(&db, start(two(), json!({}))).unwrap();
    let first = eligible(&db, 1, 'b');
    let second = eligible(&db, 2, 'c');
    for id in [&first, &second] {
        assert_eq!(get(&db, "candidates", id).unwrap()["status"], "eligible");
    }
    // The existing owner decision: no reviewer pick is needed among sandbox candidates.
    let receipt = call(
        &db,
        json!({"op":"accept","request_id":"pick-second","candidate":second,
        "expected_commit":"a".repeat(40),"expected_version":0,
        "rationale":"Smaller change","alternatives":[first]}),
    )
    .unwrap();
    assert_eq!(receipt["status"], "publication_pending");
    assert_eq!(receipt["commit"], "c".repeat(40));
}

#[test]
fn a_claim_holds_one_backstop_lease_and_is_never_dispatched_twice() {
    let db = repository();
    let job = claimed(&db);
    assert_eq!(job["sandbox"], true);
    assert_eq!(job["lease_until"], 1000 + LEASE_MS);
    let again = call(
        &db,
        json!({"op":"claim","job_id":"job:run-s:agent-1","now":2000}),
    );
    assert_eq!(again.unwrap_err().code, "LEASE_HELD");
    // Lease expiry fails the attempt; recovery never queues a second sandbox.
    let late = 1001 + LEASE_MS;
    call(&db, json!({"op":"recover","now":late})).unwrap();
    let job = get(&db, "jobs", "job:run-s:agent-1").unwrap();
    assert_eq!(job["status"], "failed");
}

#[test]
fn activity_is_recorded_without_moving_the_lease() {
    let db = repository();
    let job = claimed(&db);
    let progress = |summary: &str, idle_ms: i64, now: i64| {
        call(
            &db,
            json!({"op":"sandbox_progress","job_id":job["id"],"epoch":job["epoch"],"now":now,
            "activity":{"phase":"running","last_activity_at":900,"summary":summary,"idle_ms":idle_ms}}),
        )
    };
    progress("Edit src/math.js", 0, 1500).unwrap();
    let execution = get(&db, "executions", "run-s:agent-1").unwrap();
    assert_eq!(execution["activity"]["summary"], "Edit src/math.js");
    let lease = get(&db, "jobs", "job:run-s:agent-1").unwrap()["lease_until"].clone();
    assert_eq!(lease, job["lease_until"]);
    progress("Edit src/math.js", 600_000, 601_000).unwrap();
    let execution = get(&db, "executions", "run-s:agent-1").unwrap();
    assert_eq!(execution["activity"]["idle_ms"], 600_000);
    let bad = call(
        &db,
        json!({"op":"sandbox_progress","job_id":job["id"],"epoch":job["epoch"],
        "activity":{"phase":"sleeping","last_activity_at":900}}),
    );
    assert_eq!(bad.unwrap_err().code, "INVALID_INPUT");
    let stale = call(
        &db,
        json!({"op":"sandbox_progress","job_id":job["id"],"epoch":0,
        "activity":{"phase":"running","last_activity_at":900}}),
    );
    assert_eq!(stale.unwrap_err().code, "FENCED");
}

#[test]
fn the_pushed_commit_becomes_the_candidate_and_is_evaluated_exactly() {
    let db = repository();
    let job = claimed(&db);
    let finish = |parents: Value| {
        call(
            &db,
            json!({"op":"sandbox_finish","job_id":job["id"],"epoch":job["epoch"],
            "result":{"id":"sandbox-candidate","revision":{"repository":BASE,"commit":"c".repeat(40)},
            "parents":parents,"tree":"d".repeat(40),"paths":["src/math.js","test/math.test.js"],
            "summary":"Added add(a,b)","diff_digest":"e".repeat(64)}}),
        )
    };
    // Only one commit on the frozen base is a candidate.
    assert_eq!(
        finish(json!(["f".repeat(40)])).unwrap_err().code,
        "INVALID_CAPTURE"
    );
    finish(json!(["a".repeat(40)])).unwrap();
    let candidate = get(&db, "candidates", "sandbox-candidate").unwrap();
    assert_eq!(candidate["revision"]["commit"], "c".repeat(40));
    assert_eq!(candidate["status"], "evaluating");
    let evaluator = get(&db, "jobs", "evaluate:sandbox-candidate").unwrap();
    assert_eq!(
        evaluator["payload"]["candidate"]["revision"]["commit"],
        "c".repeat(40)
    );
    assert_eq!(evaluator["payload"]["workspace_transport"], TRANSPORT);
    let done = get(&db, "jobs", "job:run-s:agent-1").unwrap();
    assert_eq!(done["status"], "done");
    assert!(
        crate::storage::get(&db, "jobs", "capture:run-s:agent-1").is_err(),
        "no capture job"
    );
}

#[test]
fn a_cli_failure_reason_reaches_the_run() {
    let db = repository();
    let job = claimed(&db);
    call(
        &db,
        json!({"op":"fail","job_id":job["id"],"epoch":job["epoch"],
        "error":"Claude Code failed: API Error: 401","retryable":true}),
    )
    .unwrap();
    let execution = get(&db, "executions", "run-s:agent-1").unwrap();
    assert_eq!(execution["status"], "failed");
    assert_eq!(execution["error"], "Claude Code failed: API Error: 401");
    let run = get(&db, "runs", "run-s").unwrap();
    assert_eq!(run["status"], "failed");
}

#[test]
fn ordinary_attempts_cannot_use_sandbox_operations() {
    let db = repository();
    let mut c = start(glm(), json!({}));
    c["workspace_transport"] = json!("api-source-v1");
    call(&db, c).unwrap();
    let job = call(&db, json!({"op":"claim","job_id":"job:run-s:agent-1"})).unwrap();
    assert!(job.get("sandbox").is_none());
    let refused = call(
        &db,
        json!({"op":"sandbox_finish","job_id":job["id"],"epoch":job["epoch"],"result":{}}),
    );
    assert_eq!(refused.unwrap_err().code, "FORBIDDEN");
}

/// A recorded sandbox candidate and its claimed evaluation job.
fn checked(db: &NativeStore) -> Value {
    let job = claimed(db);
    call(
        db,
        json!({"op":"sandbox_finish","job_id":job["id"],"epoch":job["epoch"],
        "result":{"id":"sandbox-candidate","revision":{"repository":BASE,"commit":"c".repeat(40)},
        "parents":["a".repeat(40)],"tree":"d".repeat(40),"paths":["src/math.js"],
        "summary":"Added add(a,b)","diff_digest":"e".repeat(64)}}),
    )
    .unwrap();
    call(
        db,
        json!({"op":"claim","job_id":"evaluate:sandbox-candidate"}),
    )
    .unwrap()
}

/// What the check sandbox reports: the evaluator container's report format, field for field.
fn check_report(exit: Value) -> Value {
    json!({"setup":[],"commands":[{"name":"build","output":{"exit":exit,"signal":null,
        "stdout":"","stderr":"","stdout_truncated":false,"stderr_truncated":false}}],
        "environment":"linux-node24-rust1.94-v1","suite":"commands-v1",
        "test_bundle_digest":null,"protected_changes":[],"test_bundle_policy_digest":null})
}

fn verify(db: &NativeStore, job: &Value, report: Value) -> Result<Value> {
    call(
        db,
        json!({"op":"verify_finish","job_id":job["id"],"epoch":job["epoch"],
        "report":report,"evidence":"f".repeat(64)}),
    )
}

#[test]
fn a_sandbox_candidate_is_checked_by_one_fresh_sandbox_attempt() {
    let db = repository();
    let job = checked(&db);
    assert_eq!(job["sandbox_check"], true);
    assert_eq!(job["lease_until"], 1000 + CHECK_LEASE_MS);
    assert_eq!(job["attempt_deadline"], 1000 + CHECK_LEASE_MS);
    // Lease expiry fails the check; recovery never starts a second check sandbox.
    call(&db, json!({"op":"recover","now":1001 + CHECK_LEASE_MS})).unwrap();
    let job = get(&db, "jobs", "evaluate:sandbox-candidate").unwrap();
    assert_eq!(job["status"], "failed");
    // A static site policy too: the check sandbox captures its output directory.
    let mut policy = repo(&db).unwrap()["policy"].clone();
    policy["build"]["static_dir"] = json!("public");
    let mut evaluator = json!({"kind":"evaluate","payload":{"run_id":"run-s","policy":policy}});
    claimed_check(&db, &mut evaluator, 1000).unwrap();
    assert_eq!(evaluator["sandbox_check"], true);
}

#[test]
fn a_check_without_sandbox_capacity_is_retried_and_never_fails_the_candidate() {
    let db = repository();
    let job = checked(&db);
    let deferred = call(
        &db,
        json!({"op":"defer_job","job_id":job["id"],"epoch":job["epoch"],
        "reason":"container_capacity","now":1500}),
    )
    .unwrap();
    assert_eq!(deferred["status"], "queued");
    let candidate = get(&db, "candidates", "sandbox-candidate").unwrap();
    assert_eq!(candidate["status"], "evaluating");
    // After its backoff: a fresh check sandbox under the next epoch, with a fresh lease.
    let again = call(
        &db,
        json!({"op":"claim","job_id":"evaluate:sandbox-candidate","now":10_000}),
    )
    .unwrap();
    assert_eq!(again["sandbox_check"], true);
    assert!(again["epoch"].as_i64() > job["epoch"].as_i64());
    assert_eq!(again["lease_until"], 10_000 + CHECK_LEASE_MS);
    verify(&db, &again, check_report(json!(0))).unwrap();
    let candidate = get(&db, "candidates", "sandbox-candidate").unwrap();
    assert_eq!(candidate["status"], "eligible");
}

#[test]
fn the_check_sandbox_report_makes_the_candidate_eligible() {
    let db = repository();
    let job = checked(&db);
    verify(&db, &job, check_report(json!(0))).unwrap();
    let candidate = get(&db, "candidates", "sandbox-candidate").unwrap();
    assert_eq!(candidate["status"], "eligible");
    let evaluation = get(
        &db,
        "evaluations",
        candidate["evaluation"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(evaluation["revision"]["commit"], "c".repeat(40));
    assert_eq!(evaluation["checks"][0]["status"], "pass");
}

#[test]
fn a_failing_or_timed_out_check_rejects_the_candidate() {
    for exit in [json!(1), Value::Null] {
        let db = repository();
        let job = checked(&db);
        verify(&db, &job, check_report(exit)).unwrap();
        let candidate = get(&db, "candidates", "sandbox-candidate").unwrap();
        assert_eq!(candidate["status"], "rejected");
    }
}

#[test]
fn an_invalid_check_report_is_refused() {
    let db = repository();
    let job = checked(&db);
    let mut wrong = check_report(json!(0));
    wrong["environment"] = json!("sandbox-node24");
    assert_eq!(
        verify(&db, &job, wrong).unwrap_err().code,
        "ENVIRONMENT_MISMATCH"
    );
    let mut stale = job.clone();
    stale["epoch"] = json!(0);
    assert_eq!(
        verify(&db, &stale, check_report(json!(0)))
            .unwrap_err()
            .code,
        "FENCED"
    );
    // A report without the required check is no pass.
    let mut missing = check_report(json!(0));
    missing["commands"] = json!([]);
    verify(&db, &job, missing).unwrap();
    let candidate = get(&db, "candidates", "sandbox-candidate").unwrap();
    assert_eq!(candidate["status"], "rejected");
}

fn bundle_repository(app: bool) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let mut policy = json!({"version":"sandbox-bundle","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","/opt/yoneda/test-bundle/run.mjs"],"timeout_seconds":30}],
        "test_bundle":{"digest":"a".repeat(64),"protected_paths":["tests"]}}});
    if app {
        policy["build"]["app"] = json!({"version":1,"entrypoint":"dist/worker.js",
            "export_name":"App","migrations":[{"version":1,
            "sql":["CREATE TABLE bookings (id TEXT PRIMARY KEY)"]}],"seed":[]});
    }
    call(&db, json!({"op":"init","id":"sandbox","name":"Sandbox","remote":{"namespace":"yoneda-dev","name":"sandbox"},"commit":"a".repeat(40),"policy":policy})).unwrap();
    db
}

#[test]
fn an_immutable_test_bundle_is_checked_in_the_check_sandbox() {
    let db = bundle_repository(false);
    let job = checked(&db);
    assert_eq!(job["sandbox_check"], true);
    assert_eq!(
        job["payload"]["policy"]["build"]["test_bundle"]["digest"],
        "a".repeat(64)
    );
}

#[test]
fn app_bundle_and_guided_sandbox_runs_are_refused_at_start() {
    let db = bundle_repository(true);
    let refused = call(&db, start(glm(), json!({}))).unwrap_err();
    assert_eq!(refused.code, "NOT_SUPPORTED");
    assert!(refused.message.contains("app bundles"));
    // The same project still starts ordinary runs (their checks keep the evaluator container).
    let mut c = start(glm(), json!({}));
    c["workspace_transport"] = json!("api-source-v1");
    call(&db, c).unwrap();
    let mut evaluator = json!({"kind":"evaluate","payload":{"run_id":"run-s","policy":repo(&db).unwrap()["policy"]}});
    claimed_check(&db, &mut evaluator, 1000).unwrap();
    assert!(evaluator.get("sandbox_check").is_none());
    let guided = json!({"runtime":TRANSPORT,"guided":{"session_id":"s"}});
    assert_eq!(
        checkable_start(&guided, &json!({})).unwrap_err().code,
        "NOT_SUPPORTED"
    );
}

#[test]
fn each_agent_runs_a_stock_cli_its_provider_supports() {
    let db = repository();
    let agents = json!([
        {"provider":"zai","model":"glm-5.3-flash","strategy":"default"},
        {"provider":"codex","model":"gpt-5.6-luna","strategy":"codex"},
        {"provider":"zai","model":"glm-5.3-flash","strategy":"opencode","cli":"opencode"},
        {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"mimo","cli":"mimo"},
        {"provider":"gemini","model":"gemini-3.8-flash","strategy":"gemini"},
    ]);
    let run = call(&db, start(agents, json!({}))).unwrap();
    let frozen: Vec<_> = run["agents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|agent| agent["cli"].clone())
        .collect();
    // Unchosen CLIs default by provider: Claude Code, Codex CLI, opencode for Gemini.
    assert_eq!(
        frozen,
        ["claude", "codex", "opencode", "mimo", "opencode"].map(|cli| json!(cli))
    );
    for (n, cli) in frozen.iter().enumerate() {
        let execution = get(&db, "executions", &format!("run-s:agent-{}", n + 1)).unwrap();
        assert_eq!(&execution["cli"], cli);
    }
}

#[test]
fn a_cli_that_cannot_drive_the_provider_is_refused_before_the_run_starts() {
    let db = repository();
    let refused = |provider: &str, model: &str, cli: &str| {
        call(
            &db,
            start(
                json!([{"provider":provider,"model":model,"strategy":"one","cli":cli}]),
                json!({}),
            ),
        )
        .unwrap_err()
        .code
    };
    // Claude Code speaks Anthropic Messages only; Codex CLI the OpenAI Responses API only.
    assert_eq!(
        refused("codex", "gpt-5.6-luna", "claude"),
        "SANDBOX_HARNESS"
    );
    assert_eq!(refused("zai", "glm-5.3-flash", "codex"), "SANDBOX_HARNESS");
    assert_eq!(
        refused("gemini", "gemini-3.8-flash", "claude"),
        "SANDBOX_HARNESS"
    );
    assert_ne!(refused("zai", "glm-5.3-flash", "aider"), "SANDBOX_HARNESS");
    assert!(get(&db, "runs", "run-s").is_err(), "nothing was created");
}

#[test]
fn a_sandbox_run_started_under_the_old_tag_still_runs_and_is_checked() {
    let db = repository();
    call(&db, start(glm(), json!({}))).unwrap();
    // What a sandbox run recorded before it had its own tag.
    let mut run = get(&db, "runs", "run-s").unwrap();
    run["workspace_transport"] = json!("api-source-v1");
    save(&db, "runs", "run-s", &run).unwrap();
    let job = call(&db, json!({"op":"claim","job_id":"job:run-s:agent-1"})).unwrap();
    assert_eq!(job["sandbox"], true);
    assert!(platform_source(&run["workspace_transport"]));
    let mut evaluator = json!({"kind":"evaluate","payload":{"run_id":"run-s","policy":repo(&db).unwrap()["policy"]}});
    claimed_check(&db, &mut evaluator, 1000).unwrap();
    assert_eq!(evaluator["sandbox_check"], true);
}
