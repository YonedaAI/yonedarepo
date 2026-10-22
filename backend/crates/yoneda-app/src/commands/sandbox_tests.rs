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

fn claimed(db: &NativeStore) -> Value {
    call(db, start(glm(), json!({}))).unwrap();
    call(db, json!({"op":"claim","job_id":"job:run-s:agent-1"})).unwrap()
}

#[test]
fn only_single_agent_runs_take_the_sandbox() {
    let db = repository();
    let two = json!([glm()[0], {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"other"}]);
    assert_eq!(
        call(&db, start(two, json!({}))).unwrap_err().code,
        "NOT_SUPPORTED"
    );
    let team = start(glm(), json!({"mode":"collaborate"}));
    assert_eq!(call(&db, team).unwrap_err().code, "NOT_SUPPORTED");
    let run = call(&db, start(glm(), json!({}))).unwrap();
    assert_eq!(run["runtime"], TRANSPORT);
    // Evaluation and readers keep the run's lazy-source transport.
    assert_eq!(run["workspace_transport"], "api-source-v1");
    let execution = get(&db, "executions", "run-s:agent-1").unwrap();
    assert_eq!(execution["runtime"], TRANSPORT);
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
    assert_eq!(evaluator["payload"]["workspace_transport"], "api-source-v1");
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
