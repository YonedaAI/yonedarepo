use super::*;
use crate::native::NativeStore;

const JOB: &str = "job:run-s:agent-1";

fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    if c.get("now").is_none() {
        c["now"] = json!(1000);
    }
    crate::execute(db, c)
}

/// A claimed one-agent sandbox run whose GLM group may spend 500 microdollars.
fn claimed(spend_limit: Value) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let policy = json!({"version":"sandbox-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","src/math.js"],"timeout_seconds":30}]}});
    call(&db, json!({"op":"init","id":"sandbox","name":"Sandbox","remote":{"namespace":"yoneda-dev","name":"sandbox"},"commit":"a".repeat(40),"policy":policy})).unwrap();
    let budget = json!({"provider":"zai","model":"glm-5.3-flash","max_requests":null,
        "max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":spend_limit,
        "pricing":{"input_microusd_per_million":150000,"output_microusd_per_million":500000,
        "source":"owner-approved conservative rates"}});
    call(&db, json!({"op":"start_run","id":"run-s","intent":"Add add(a,b)",
        "agents":[{"provider":"zai","model":"glm-5.3-flash","strategy":"minimal"}],
        "model_budgets":[budget],"workspace_transport":super::super::sandbox::TRANSPORT,
        "_source_transport_approved":true,
        "_source_base":{"repository":"yoneda-dev/sandbox","commit":"a".repeat(40),"tree":"b".repeat(40)}}))
    .unwrap();
    call(&db, json!({"op":"claim","job_id":JOB})).unwrap();
    db
}

fn report(db: &NativeStore, response: &str, input: i64, output: i64) -> Result<Value> {
    call(
        db,
        json!({"op":"sandbox_usage","job_id":JOB,"epoch":1,"response_id":response,
        "usage":{"input_tokens":input,"cache_read_input_tokens":0,"output_tokens":output}}),
    )
}

fn exhausted(db: &NativeStore) -> bool {
    call(db, json!({"op":"sandbox_budget","job_id":JOB,"epoch":1})).unwrap()["exhausted"] == true
}

#[test]
fn metered_responses_add_real_spend_and_refuse_only_once_it_is_used_up() {
    let db = claimed(json!(500));
    assert!(!exhausted(&db));
    // 1000 input at $0.15/M and 400 output at $0.50/M: 350 microdollars.
    let first = report(&db, "r1", 1000, 400).unwrap();
    assert_eq!(first["charged_microusd"], 350);
    assert_eq!(first["exhausted"], false);
    assert!(!exhausted(&db), "350 of 500 spent: the next request goes");
    let second = report(&db, "r2", 1000, 400).unwrap();
    assert_eq!(second["exhausted"], true);
    assert!(
        exhausted(&db),
        "700 of 500 spent: the next request is refused"
    );
    let run = get(&db, "runs", "run-s").unwrap();
    assert_eq!(run["model_budgets"][0]["charged_microusd"], 700);
    assert_eq!(run["model_budgets"][0]["requests"], 2);
    assert_eq!(
        run["metered_usage"]["zai/glm-5.3-flash"],
        json!({"requests":2,"charged_microusd":700,"input_tokens":2000,
            "cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":800})
    );
    let execution = get(&db, "executions", "run-s:agent-1").unwrap();
    assert_eq!(execution["metered_usage"]["output_tokens"], 800);
}

#[test]
fn a_repeated_report_counts_once_and_cannot_change() {
    let db = claimed(json!(500));
    report(&db, "r1", 1000, 400).unwrap();
    report(&db, "r1", 1000, 400).unwrap();
    assert_eq!(
        get(&db, "runs", "run-s").unwrap()["model_budgets"][0]["charged_microusd"],
        350
    );
    assert_eq!(
        report(&db, "r1", 1, 1).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
}

#[test]
fn spend_after_cancellation_is_kept_but_no_new_request_starts() {
    let db = claimed(json!(500));
    call(&db, json!({"op":"cancel_run","run_id":"run-s"})).unwrap();
    // The response that was streaming when the run stopped still cost money.
    report(&db, "r1", 1000, 400).unwrap();
    assert_eq!(
        get(&db, "runs", "run-s").unwrap()["model_budgets"][0]["charged_microusd"],
        350
    );
    let refused = call(&db, json!({"op":"sandbox_budget","job_id":JOB,"epoch":1}));
    assert_eq!(refused.unwrap_err().code, "FENCED");
    // An epoch the attempt never had reports nothing.
    let unknown = call(
        &db,
        json!({"op":"sandbox_usage","job_id":JOB,"epoch":99,"response_id":"r2","usage":{}}),
    );
    assert_eq!(unknown.unwrap_err().code, "FENCED");
}

#[test]
fn without_a_spend_limit_usage_is_recorded_and_never_refused() {
    let db = claimed(Value::Null);
    report(&db, "r1", 10_000_000, 1_000_000).unwrap();
    assert!(!exhausted(&db));
    assert_eq!(
        report(&db, "bad id!", 1, 1).unwrap_err().code,
        "INVALID_INPUT"
    );
    let negative = call(
        &db,
        json!({"op":"sandbox_usage","job_id":JOB,"epoch":1,"response_id":"r3",
        "usage":{"input_tokens":-1}}),
    );
    assert_eq!(negative.unwrap_err().code, "INVALID_INPUT");
}
