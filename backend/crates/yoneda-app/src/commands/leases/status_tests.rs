use super::*;
use crate::commands::recovery::source_tests as fixture;

#[test]
fn capture_failure_reports_trusted_stage_and_keeps_producer_identity() {
    let db = fixture::fixture();
    fixture::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    let mut producer = get(&db, "executions", "execution").unwrap();
    producer["status"] = json!("capturing");
    save(&db, "executions", "execution", &producer).unwrap();
    job(
        &db,
        "capture:execution",
        "capture",
        1000,
        json!({"execution":producer,"run_id":"run","base":producer["base"]}),
    )
    .unwrap();
    let capture = fixture::call(
        &db,
        json!({"op":"claim","job_id":"capture:execution"}),
        1000,
    )
    .unwrap();
    fixture::call(
        &db,
        json!({"op":"fail","job_id":capture["id"],"epoch":capture["epoch"],
            "retryable":false,"error":"RUNTIME: {\"error\":{\"code\":\"FENCED\"}}",
            "failure_stage":"agent"}),
        1000,
    )
    .unwrap();
    let failed = get(&db, "executions", "execution").unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["failure_stage"], "capture");
    assert_eq!(failed["failure_job_id"], "capture:execution");
    assert_eq!(failed["failure_job_epoch"], capture["epoch"]);
    assert_eq!(failed["epoch"], producer["epoch"]);
}

#[test]
fn hashed_capture_lifecycle_events_identify_the_saved_execution() {
    let db = fixture::fixture();
    fixture::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    let mut producer = get(&db, "executions", "execution").unwrap();
    producer["status"] = json!("capturing");
    save(&db, "executions", "execution", &producer).unwrap();
    let id = "capture:source-retry:opaque-hash";
    job(
        &db,
        id,
        "capture",
        1000,
        json!({"execution":producer,"run_id":"run"}),
    )
    .unwrap();
    let capture = fixture::call(&db, json!({"op":"claim","job_id":id}), 1000).unwrap();
    fixture::call(
        &db,
        json!({"op":"progress","job_id":id,"epoch":capture["epoch"],
        "progress":{"stage":"capture","run_id":"forged","execution_id":"neighbor"}}),
        1001,
    )
    .unwrap();
    fixture::call(
        &db,
        json!({"op":"fail","job_id":id,"epoch":capture["epoch"],
        "retryable":false,"error":"Capture unavailable"}),
        1002,
    )
    .unwrap();
    let response = fixture::call(&db, json!({"op":"events"}), 1002).unwrap();
    let events = response["events"].as_array().unwrap();
    for kind in ["job.started", "job.progress", "job.failed"] {
        let record = events
            .iter()
            .find(|event| event["kind"] == kind && event["data"]["id"] == id)
            .unwrap();
        assert_eq!(record["data"]["run_id"], "run", "{kind}");
        assert_eq!(record["data"]["execution_id"], "execution", "{kind}");
        assert_eq!(record["data"]["kind"], "capture", "{kind}");
    }
}

#[test]
fn failed_compare_run_names_the_failing_agent_model_and_code() {
    let db = fixture::fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["mode"] = json!("compare");
    save(&db, "runs", "run", &run).unwrap();
    let claimed = fixture::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    fixture::call(
        &db,
        json!({"op":"fail","job_id":"job:execution","epoch":claimed["epoch"],
            "retryable":false,"error":"EXECUTION_TIMEOUT: Execution deadline exceeded"}),
        1000,
    )
    .unwrap();
    let run = get(&db, "runs", "run").unwrap();
    assert_eq!(run["status"], "failed");
    assert_eq!(run["error"]["code"], "EXECUTION_TIMEOUT");
    let message = run["error"]["message"].as_str().unwrap();
    for part in ["execution", "codex/gpt-5.6-luna", "EXECUTION_TIMEOUT"] {
        assert!(message.contains(part), "{message} lacks {part}");
    }
    assert_eq!(run["error"]["executions"][0]["id"], "execution");
}
