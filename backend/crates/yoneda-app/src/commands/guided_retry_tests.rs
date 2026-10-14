//! Step-level retry after terminal failure, using Native ledger commands only.
use super::*;
fn retry(view: &Value, step: &str, request_id: &str) -> Value {
    let mut c = request(step);
    c["request_id"] = json!(request_id);
    c["retry"] = json!(true);
    c["expected_commit"] = view["working_revision"]["commit"].clone();
    c["expected_version"] = view["working_version"].clone();
    c
}
fn cancel(db: &NativeStore, rid: &str) {
    execute(db, json!({"op":"cancel_run","run_id":rid,"now":3})).unwrap();
}
fn failed_build() -> (NativeStore, String) {
    let db = fixture();
    let started = execute(&db, request("build")).unwrap();
    let rid = started["steps"][0]["run_ids"][0]
        .as_str()
        .unwrap()
        .to_owned();
    cancel(&db, &rid);
    assert_eq!(read(&db)["steps"][0]["status"], "needs_attention");
    (db, rid)
}
fn snapshot(db: &NativeStore) -> Value {
    execute(db, json!({"op":"snapshot"})).unwrap()
}
#[test]
fn guided_retry_allocates_suffixed_runs_and_judges_only_latest_attempt() {
    let (db, first) = failed_build();
    let view = read(&db);
    assert_eq!(view["steps"][0]["attempt"], 1);
    let retried = execute(&db, retry(&view, "build", "retry-build-1")).unwrap();
    let second = format!("{first}-r2");
    assert_eq!(retried["steps"][0]["status"], "running");
    assert_eq!(retried["steps"][0]["run_ids"], json!([second]));
    assert_eq!(retried["steps"][0]["attempt"], 2);
    assert_eq!(retried["steps"][0]["previous_run_ids"], json!([first]));
    assert_eq!(get(&db, "runs", &first).unwrap()["status"], "cancelled");
    assert_eq!(
        get(&db, "runs", &second).unwrap()["guided"],
        json!({"session_id":"guide-session:demo","profile_id":"task-board-v1","version":1,"step_id":"build","check_phase":"build"})
    );
    // A further terminal failure can be retried again with a new request identity.
    cancel(&db, &second);
    let again = execute(&db, retry(&read(&db), "build", "retry-build-2")).unwrap();
    let third = format!("{first}-r3");
    assert_eq!(again["steps"][0]["run_ids"], json!([third]));
    assert_eq!(
        again["steps"][0]["previous_run_ids"],
        json!([first, second])
    );
    evidence_fixture::checked(&db, &third, "build", true);
    let done = read(&db);
    assert_eq!(done["steps"][0]["status"], "complete");
    assert_eq!(done["steps"][1]["status"], "ready");
}
#[test]
fn guided_retry_replay_returns_same_view_without_second_allocation() {
    let (db, _) = failed_build();
    let c = retry(&read(&db), "build", "retry-build-1");
    let first = execute(&db, c.clone()).unwrap();
    let jobs = all(&db, "jobs").unwrap();
    let runs = all(&db, "runs").unwrap();
    let events = db.query("SELECT * FROM events", &[]).unwrap();
    assert_eq!(execute(&db, c).unwrap(), first);
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    assert_eq!(all(&db, "runs").unwrap(), runs);
    assert_eq!(db.query("SELECT * FROM events", &[]).unwrap(), events);
    // The original start identity cannot be reused to mean a retry.
    let mut reused = retry(&read(&db), "build", "start-build");
    reused["expected_commit"] = json!("a".repeat(40));
    assert_eq!(
        execute(&db, reused).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
}
#[test]
fn guided_retry_refused_before_start_while_active_and_after_completion() {
    let db = fixture();
    let before = snapshot(&db);
    let c = retry(&read(&db), "build", "retry-ready");
    assert_eq!(
        execute(&db, c).unwrap_err().code,
        "GUIDED_STEP_NOT_RETRYABLE"
    );
    assert_eq!(snapshot(&db), before);
    let started = execute(&db, request("build")).unwrap();
    let before = snapshot(&db);
    let c = retry(&started, "build", "retry-running");
    assert_eq!(
        execute(&db, c).unwrap_err().code,
        "GUIDED_STEP_NOT_RETRYABLE"
    );
    assert_eq!(snapshot(&db), before);
    let (db, view) = through_extend();
    let c = retry(&view, "build", "retry-complete");
    assert_eq!(
        execute(&db, c).unwrap_err().code,
        "GUIDED_STEP_NOT_RETRYABLE"
    );
}
#[test]
fn guided_retry_refused_while_a_failed_run_still_has_queued_jobs() {
    let db = fixture();
    let started = execute(&db, request("build")).unwrap();
    let rid = started["steps"][0]["run_ids"][0].as_str().unwrap();
    let mut run = get(&db, "runs", rid).unwrap();
    run["status"] = json!("failed");
    save(&db, "runs", rid, &run).unwrap();
    let view = read(&db);
    assert_eq!(view["steps"][0]["status"], "needs_attention");
    let before = snapshot(&db);
    let c = retry(&view, "build", "retry-queued");
    assert_eq!(
        execute(&db, c).unwrap_err().code,
        "GUIDED_STEP_NOT_RETRYABLE"
    );
    assert_eq!(snapshot(&db), before);
}
#[test]
fn guided_retry_keeps_head_lease_and_rejects_untyped_flag() {
    let (db, _) = failed_build();
    let before = snapshot(&db);
    let mut moved = retry(&read(&db), "build", "retry-moved");
    moved["expected_commit"] = json!("b".repeat(40));
    assert_eq!(execute(&db, moved).unwrap_err().code, "HEAD_MOVED");
    let mut untyped = retry(&read(&db), "build", "retry-untyped");
    untyped["retry"] = json!("yes");
    assert_eq!(execute(&db, untyped).unwrap_err().code, "INVALID_INPUT");
    let mut count = retry(&read(&db), "build", "retry-count");
    count["_guided_runs"] = json!([]);
    assert_eq!(execute(&db, count).unwrap_err().code, "INVALID_INPUT");
    assert_eq!(snapshot(&db), before);
}
#[test]
fn guided_retry_of_concurrent_step_replaces_both_variants() {
    let (db, view) = through_extend();
    let mut c = request("concurrent");
    c["expected_commit"] = view["working_revision"]["commit"].clone();
    c["expected_version"] = view["working_version"].clone();
    c["_guided_runs"] = json!([prepared(), prepared()]);
    let started = execute(&db, c).unwrap();
    let ids: Vec<String> = started["steps"][2]["run_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect();
    for id in &ids {
        cancel(&db, id);
    }
    let mut again = retry(&read(&db), "concurrent", "retry-concurrent");
    again["_guided_runs"] = json!([prepared(), prepared()]);
    let retried = execute(&db, again).unwrap();
    assert_eq!(
        retried["steps"][2]["run_ids"],
        json!([format!("{}-r2", ids[0]), format!("{}-r2", ids[1])])
    );
    let variants: Vec<Value> = ids
        .iter()
        .map(|id| get(&db, "runs", &format!("{id}-r2")).unwrap()["guided"]["variant"].clone())
        .collect();
    assert_eq!(variants, vec![json!("filter"), json!("sort")]);
}
