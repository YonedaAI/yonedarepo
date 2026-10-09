use super::{
    single_agent::{eligible, policy, publish},
    *,
};

fn command(id: &str) -> Value {
    json!({"op":"start_run","id":id,"intent":"Improve the published website",
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]})
}
fn published() -> NativeStore {
    let db = repo_with_policy(policy());
    call(&db, command("released")).unwrap();
    let candidate = eligible(&db, "released", 1, &"b".repeat(40));
    publish(&db, &candidate, "release", &"b".repeat(40));
    call(
        &db,
        json!({"op":"context_publish","record":{"id":"context:brand","kind":"constraint",
        "statement":"Preserve the established brand colors","purpose":"Retain published decisions",
        "intent_id":"intent:released","links":[]}}),
    )
    .unwrap();
    db
}
fn continuation(id: &str, decision: &str) -> Value {
    let mut c = command(id);
    c["continuation_of"] = json!(decision);
    c["context"] = json!(["context:brand"]);
    c
}
fn assert_rejected_atomically(db: &NativeStore, input: Value, code: &str) {
    let before = call(db, json!({"op":"snapshot"})).unwrap();
    let outbox = call(db, json!({"op":"outbox"})).unwrap();
    assert_eq!(call(db, input).unwrap_err().code, code);
    assert_eq!(call(db, json!({"op":"snapshot"})).unwrap(), before);
    assert_eq!(call(db, json!({"op":"outbox"})).unwrap(), outbox);
}

#[test]
fn continuation_ignores_newer_failed_or_unpublished_work_and_delivers_frozen_context() {
    let db = published();
    let mut failed = command("newer-failed");
    failed["now"] = json!(2000);
    call(&db, failed).unwrap();
    call(
        &db,
        json!({"op":"claim","job_id":"job:newer-failed:agent-1","now":2001}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"fail","job_id":"job:newer-failed:agent-1","epoch":1,
        "retryable":false,"error":"Synthetic failure","now":2002}),
    )
    .unwrap();
    let mut unpublished = command("newer-unpublished");
    unpublished["now"] = json!(3000);
    call(&db, unpublished).unwrap();
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    let mut request = continuation("update", "decision:release");
    request["now"] = json!(4000);
    let update = call(&db, request).unwrap();
    assert_eq!(update["continuation_of"], "decision:release");
    assert_eq!(update["base"]["commit"], "b".repeat(40));
    assert_eq!(update["context_records"][0]["id"], "context:brand");
    let job = call(
        &db,
        json!({"op":"claim","job_id":"job:update:agent-1","now":4001}),
    )
    .unwrap();
    let delivered = call(
        &db,
        json!({"op":"context","job_id":job["id"],"epoch":job["epoch"],"now":4002}),
    )
    .unwrap();
    assert_eq!(delivered["run"]["continuation_of"], "decision:release");
    assert_eq!(
        delivered["run"]["context_records"],
        update["context_records"]
    );
    let after = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(after["capabilities"]["published_continuation"], 1);
    assert!(
        after["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["source"] == "decision:release"
                && edge["target"] == "update"
                && edge["relation"] == "continues")
    );
    for historical in before["runs"].as_array().unwrap() {
        assert!(after["runs"].as_array().unwrap().contains(historical));
    }
}

#[test]
fn a_stale_published_decision_cannot_schedule_an_update_after_another_release() {
    let db = published();
    call(&db, continuation("next", "decision:release")).unwrap();
    let candidate = eligible(&db, "next", 1, &"c".repeat(40));
    publish(&db, &candidate, "next-release", &"c".repeat(40));
    assert_rejected_atomically(&db, continuation("stale", "decision:release"), "HEAD_MOVED");
    let current = call(&db, continuation("current", "decision:next-release")).unwrap();
    assert_eq!(current["base"]["commit"], "c".repeat(40));
}

#[test]
fn continuation_rejects_missing_unpublished_malformed_or_mixed_provenance() {
    let db = published();
    assert_rejected_atomically(
        &db,
        continuation("missing", "decision:missing"),
        "NOT_FOUND",
    );
    for value in [Value::Null, json!(42), json!("")] {
        let mut invalid = command("invalid");
        invalid["continuation_of"] = value;
        assert_rejected_atomically(&db, invalid, "INVALID_INPUT");
    }
    let mut unpublished = crate::storage::get(&db, "decisions", "decision:release").unwrap();
    unpublished["id"] = json!("decision:unpublished");
    unpublished["request_id"] = json!("unpublished");
    unpublished["receipt"]["id"] = json!("decision:unpublished");
    unpublished["status"] = json!("publication_pending");
    // Historical pending evidence may survive an operator reconciliation; it is never a release.
    crate::storage::create(&db, "decisions", "decision:unpublished", &unpublished).unwrap();
    assert_rejected_atomically(
        &db,
        continuation("not-published", "decision:unpublished"),
        "INVALID_STATE",
    );
    let mut mixed = continuation("mixed", "decision:release");
    mixed["restart_of"] = json!("missing-run");
    assert_rejected_atomically(&db, mixed, "INVALID_INPUT");
}

#[test]
fn pending_publication_is_checked_before_continuation_provenance() {
    let db = published();
    call(&db, command("pending")).unwrap();
    let candidate = eligible(&db, "pending", 1, &"c".repeat(40));
    call(&db, json!({"op":"accept","request_id":"pending-release","candidate":candidate,
        "expected_commit":"b".repeat(40),"expected_version":1,"rationale":"Synthetic owner selection"})).unwrap();
    assert_rejected_atomically(
        &db,
        continuation("blocked", "decision:pending-release"),
        "PUBLICATION_PENDING",
    );
}
