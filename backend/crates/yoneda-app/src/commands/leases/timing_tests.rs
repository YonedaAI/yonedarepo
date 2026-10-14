//! Durable lifecycle times let an external driver attribute stage durations from a snapshot.
use super::*;
use crate::commands::recovery::source_tests as fixture;

fn snapshot_job(db: &crate::native::NativeStore, id: &str) -> Value {
    let snapshot = fixture::call(db, json!({"op":"snapshot"}), 9000).unwrap();
    snapshot["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|j| j["id"] == id)
        .cloned()
        .unwrap()
}

#[test]
fn snapshot_exposes_job_creation_claim_and_terminal_times_without_payloads() {
    let db = fixture::fixture();
    let created = get(&db, "jobs", "job:execution").unwrap()["created_at"].clone();
    assert!(created.is_i64());
    fixture::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    let mut producer = get(&db, "executions", "execution").unwrap();
    assert_eq!(producer["started_at"], 1000);
    producer["status"] = json!("capturing");
    save(&db, "executions", "execution", &producer).unwrap();
    job(
        &db,
        "capture:execution",
        "capture",
        1500,
        json!({"execution":producer,"run_id":"run","base":producer["base"]}),
    )
    .unwrap();
    let capture = fixture::call(
        &db,
        json!({"op":"claim","job_id":"capture:execution"}),
        2000,
    )
    .unwrap();
    fixture::call(
        &db,
        json!({"op":"fail","job_id":capture["id"],"epoch":capture["epoch"],"retryable":false,"error":"capture failed"}),
        3000,
    )
    .unwrap();
    let view = snapshot_job(&db, "capture:execution");
    assert_eq!(view["kind"], "capture");
    assert_eq!(view["status"], "failed");
    assert_eq!(view["created_at"], 1500);
    assert_eq!(view["started_at"], 2000);
    assert_eq!(view["finished_at"], 3000);
    assert_eq!(view["execution_id"], "execution");
    assert_eq!(view["run_id"], "run");
    assert!(view.get("payload").is_none());
    assert_eq!(snapshot_job(&db, "job:execution")["started_at"], 1000);
    assert_eq!(snapshot_job(&db, "job:execution")["created_at"], created);
    let failed = get(&db, "executions", "execution").unwrap();
    assert_eq!(failed["finished_at"], 3000);
}

#[test]
fn a_retryable_failure_is_not_terminal_and_a_new_claim_resets_the_attempt_times() {
    let db = fixture::fixture();
    let first = fixture::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1000).unwrap();
    fixture::call(
        &db,
        json!({"op":"fail","job_id":"job:execution","epoch":first["epoch"],"retryable":true,"error":"transient"}),
        1100,
    )
    .unwrap();
    let queued = get(&db, "jobs", "job:execution").unwrap();
    assert_eq!(queued["status"], "queued");
    assert!(queued["finished_at"].is_null());
    let mut stale = get(&db, "executions", "execution").unwrap();
    stale["finished_at"] = json!(1150);
    save(&db, "executions", "execution", &stale).unwrap();
    fixture::call(&db, json!({"op":"claim","job_id":"job:execution"}), 1200).unwrap();
    assert_eq!(
        get(&db, "jobs", "job:execution").unwrap()["started_at"],
        1200
    );
    let execution = get(&db, "executions", "execution").unwrap();
    assert_eq!(execution["started_at"], 1200);
    assert!(execution["finished_at"].is_null());
}
