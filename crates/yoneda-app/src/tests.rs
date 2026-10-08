use super::*;
use crate::native::NativeStore;
use serde_json::json;

fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    if c.get("now").is_none() {
        c["now"] = json!(1000);
    }
    execute(db, c)
}
fn repo() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"init","id":"repo-test","name":"Retry client","remote":{"namespace":"yoneda-dev","name":"retry"},"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","policy":yoneda_core::Policy::default()})).unwrap();
    db
}
fn start(db: &NativeStore) -> Value {
    call(db,json!({"op":"start_run","id":"run-one","intent":"Retry transient failures within a bounded deadline","criteria":["Do not retry unsafe writes"]})).unwrap()
}
#[test]
fn run_creation_commits_graph_and_dispatch_together() {
    let db = repo();
    let r = start(&db);
    assert_eq!(
        r["base"]["commit"],
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["runs"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["executions"].as_array().unwrap().len(), 1);
    assert!(
        snapshot["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "intent")
    );
    assert_eq!(
        call(&db, json!({"op":"outbox"})).unwrap()["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|j| j["kind"] == "agent")
            .count(),
        1
    );
    assert!(
        call(
            &db,
            json!({"op":"start_run","id":"run-one","intent":"duplicate"})
        )
        .is_err()
    );
}
#[test]
fn duplicate_claims_and_late_completions_are_fenced() {
    let db = repo();
    start(&db);
    let job = "job:run-one:research";
    let claim = call(&db, json!({"op":"claim","job_id":job})).unwrap();
    assert_eq!(claim["epoch"], 1);
    assert_eq!(
        call(&db, json!({"op":"claim","job_id":job}))
            .unwrap_err()
            .code,
        "LEASE_HELD"
    );
    call(&db, json!({"op":"recover","now":62000})).unwrap();
    let second = call(&db, json!({"op":"claim","job_id":job,"now":62000})).unwrap();
    assert_eq!(second["epoch"], 2);
    assert_eq!(
        call(
            &db,
            json!({"op":"finish","job_id":job,"epoch":1,"now":62001,"result":{}})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
}
#[test]
fn failed_mutations_rollback_the_event_log() {
    let db = repo();
    start(&db);
    let before = call(&db, json!({"op":"events","after":0})).unwrap();
    assert!(call(&db,json!({"op":"publish_artifact","job_id":"job:run-one:research","epoch":99,"id":"artifact","digest":"bad","label":"test","kind":"research","metadata":{}})).is_err());
    assert_eq!(before, call(&db, json!({"op":"events","after":0})).unwrap());
}
#[test]
fn research_completion_launches_three_harnesses_with_identical_context() {
    let db = repo();
    start(&db);
    let job = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    call(&db,json!({"op":"publish_artifact","job_id":job,"epoch":1,"id":"research-a","digest":"b".repeat(64),"label":"Latency assumptions","kind":"research","metadata":{"assumptions":[{"statement":"Upstream replies within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/retry.rs"}]}})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":job,"epoch":1,"result":{}}),
    )
    .unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    let coding: Vec<_> = s["executions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["role"] == "coding")
        .collect();
    assert_eq!(coding.len(), 3);
    assert_eq!(coding[0]["context"], json!(["research-a"]));
    assert_eq!(coding[0]["context"], coding[1]["context"]);
    assert!(coding.iter().any(|e| e["harness"] == "codex"));
    assert!(coding.iter().any(|e| e["harness"] == "claude"));
}
fn ready(db: &NativeStore) -> Value {
    start(db);
    let research = "job:run-one:research";
    call(db, json!({"op":"claim","job_id":research})).unwrap();
    call(db,json!({"op":"publish_artifact","job_id":research,"epoch":1,"id":"research-a","digest":"b".repeat(64),"label":"Research","kind":"research","metadata":{}})).unwrap();
    call(
        db,
        json!({"op":"finish","job_id":research,"epoch":1,"result":{}}),
    )
    .unwrap();
    let coding = "job:run-one:codex-minimal";
    call(db, json!({"op":"claim","job_id":coding})).unwrap();
    call(
        db,
        json!({"op":"finish","job_id":coding,"epoch":1,"result":{"workspace":"b".repeat(64)}}),
    )
    .unwrap();
    let capture = "capture:run-one:codex-minimal";
    call(db, json!({"op":"claim","job_id":capture})).unwrap();
    call(db,json!({"op":"finish","job_id":capture,"epoch":1,"result":{"id":"candidate-a","revision":{"repository":"yoneda-dev/fork-a","commit":"cccccccccccccccccccccccccccccccccccccccc"},"tree":"dddddddddddddddddddddddddddddddddddddddd","paths":["src/retry.rs"],"diff":"diff --git a/src/retry.rs b/src/retry.rs\n","summary":"Bounded retry"}})).unwrap();
    let eval = "evaluate:candidate-a";
    call(db, json!({"op":"claim","job_id":eval})).unwrap();
    let evaluation = json!({"id":"evaluation-a","candidate":"candidate-a","revision":{"repository":"yoneda-dev/fork-a","commit":"cccccccccccccccccccccccccccccccccccccccc"},"policy":"retry-v1","suite":"retry-contract-v1","environment":"rust-1.94-evaluator-v1","evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"compiled"},{"name":"behavior","status":"pass","detail":"verified"}]});
    call(
        db,
        json!({"op":"finish","job_id":eval,"epoch":1,"result":evaluation}),
    )
    .unwrap();
    json!({"op":"accept","request_id":"request-a","candidate":"candidate-a","expected_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expected_version":0,"rationale":"Bounded deadline and safe retry behavior","alternatives":[]})
}
#[test]
fn acceptance_is_idempotent_and_publication_has_a_separate_receipt() {
    let db = repo();
    let request = ready(&db);
    let receipt = call(&db, request.clone()).unwrap();
    assert_eq!(receipt["status"], "publication_pending");
    assert_eq!(call(&db, request.clone()).unwrap(), receipt);
    let mut changed = request.clone();
    changed["rationale"] = json!("different");
    assert_eq!(call(&db, changed).unwrap_err().code, "IDEMPOTENCY_CONFLICT");
    assert_eq!(
        call(&db, json!({"op":"start_run","id":"run-two","intent":"new"}))
            .unwrap_err()
            .code,
        "PUBLICATION_PENDING"
    );
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(s["repository"]["version"], 1);
    assert_eq!(
        s["repository"]["published_commit"],
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert!(
        !s["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["relation"] == "published_as")
    );
    let publication = format!("publish:{}", receipt["id"].as_str().unwrap());
    call(&db, json!({"op":"claim","job_id":publication})).unwrap();
    call(&db,json!({"op":"finish","job_id":publication,"epoch":1,"result":{"commit":"cccccccccccccccccccccccccccccccccccccccc"}})).unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(
        s["repository"]["published_commit"],
        "cccccccccccccccccccccccccccccccccccccccc"
    );
    assert!(
        s["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["relation"] == "published_as")
    );
    assert_eq!(call(&db,json!({"op":"why","commit":"cccccccccccccccccccccccccccccccccccccccc","path":"src/retry.rs"})).unwrap()["coverage"],"recorded");
}
#[test]
fn stale_head_and_failed_checks_never_select_code() {
    let db = repo();
    let mut r = ready(&db);
    r["expected_version"] = json!(5);
    assert_eq!(call(&db, r.clone()).unwrap_err().code, "HEAD_MOVED");
    r["expected_version"] = json!(0);
    db.query(
        "UPDATE evaluations SET payload = json_set(payload, '$.checks[1].status', 'fail')",
        &[],
    )
    .unwrap();
    assert_eq!(call(&db, r).unwrap_err().code, "CHECKS_FAILED");
}
#[test]
fn cancellation_revokes_running_attempts() {
    let db = repo();
    start(&db);
    call(&db, json!({"op":"claim","job_id":"job:run-one:research"})).unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"run-one"})).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"heartbeat","job_id":"job:run-one:research","epoch":1})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
}

#[test]
fn migrations_are_versioned_repeatable_and_upgrade_existing_data() {
    let db = repo();
    start(&db);
    let versions = db
        .query(
            "SELECT version FROM schema_migrations ORDER BY version",
            &[],
        )
        .unwrap();
    assert_eq!(
        versions,
        json!([{"version":1},{"version":2}])
            .as_array()
            .unwrap()
            .clone()
    );
    migrate(&db).unwrap();
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM schema_migrations", &[])
            .unwrap()[0]["count"],
        2
    );
    db.query("DELETE FROM schema_migrations WHERE version=2", &[])
        .unwrap();
    db.query("DROP INDEX runs_by_status", &[]).unwrap();
    migrate(&db).unwrap();
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    db.query(
        "UPDATE schema_migrations SET digest='tampered' WHERE version=1",
        &[],
    )
    .unwrap();
    assert_eq!(migrate(&db).unwrap_err().code, "MIGRATION_DRIFT");
}

#[test]
fn exhausted_publication_exposes_operator_recovery_state() {
    let db = repo();
    let request = ready(&db);
    let receipt = call(&db, request).unwrap();
    let job = format!("publish:{}", receipt["id"].as_str().unwrap());
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    call(
        &db,
        json!({"op":"fail","job_id":job,"epoch":1,"retryable":false,"error":"Remote unavailable"}),
    )
    .unwrap();
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["repository"]["status"], "blocked");
    assert_eq!(snapshot["decisions"][0]["status"], "publication_failed");
    assert_ne!(
        snapshot["repository"]["head_commit"],
        snapshot["repository"]["published_commit"]
    );
}

#[test]
fn expired_attempt_recovery_updates_execution_status() {
    let db = repo();
    start(&db);
    let job = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    call(&db, json!({"op":"recover","now":62000})).unwrap();
    call(&db, json!({"op":"claim","job_id":job,"now":62000})).unwrap();
    call(&db, json!({"op":"recover","now":124000})).unwrap();
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["executions"][0]["status"], "failed");
}

#[test]
fn configured_model_and_transcript_remain_attached_to_execution() {
    let db = repo();
    start(&db);
    let id = "job:run-one:research";
    call(&db,json!({"op":"claim","job_id":id,"models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.6-luna"}})).unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(s["executions"][0]["model"], "claude-sonnet-4-6");
    call(&db,json!({"op":"publish_artifact","job_id":id,"epoch":1,"id":"research","digest":"b".repeat(64),"label":"Research","kind":"research","metadata":{}})).unwrap();
    call(&db,json!({"op":"finish","job_id":id,"epoch":1,"result":{"transcript":"c".repeat(64),"model":"claude-sonnet-4-6"}})).unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    let e = s["executions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["role"] == "research")
        .unwrap();
    assert_eq!(e["transcript"], "c".repeat(64));
}

#[test]
fn frozen_context_rejects_unlisted_artifacts_and_completion_hints_do_not_capture() {
    let db = repo();
    start(&db);
    let research = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":research})).unwrap();
    call(&db,json!({"op":"publish_artifact","job_id":research,"epoch":1,"id":"shared","digest":"b".repeat(64),"label":"Shared research","kind":"research","metadata":{}})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":research,"epoch":1,"result":{}}),
    )
    .unwrap();
    let coding = "job:run-one:codex-minimal";
    call(&db, json!({"op":"claim","job_id":coding})).unwrap();
    call(
        &db,
        json!({"op":"get_artifact","job_id":coding,"epoch":1,"id":"shared"}),
    )
    .unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"get_artifact","job_id":coding,"epoch":1,"id":"private-other-run"})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    let hint = call(
        &db,
        json!({"op":"hint_complete","job_id":coding,"epoch":1,"summary":"I passed every test"}),
    )
    .unwrap();
    assert_eq!(hint["authoritative"], false);
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(snapshot["candidates"].as_array().unwrap().is_empty());
    assert_eq!(
        call(&db, json!({"op":"claim","job_id":research})).unwrap()["already_done"],
        true
    );
}

#[test]
fn publication_retry_keeps_selection_reserved_until_verified_readback() {
    let db = repo();
    let receipt = call(&db, ready(&db)).unwrap();
    let id = format!("publish:{}", receipt["id"].as_str().unwrap());
    call(&db, json!({"op":"claim","job_id":id})).unwrap();
    call(&db,json!({"op":"fail","job_id":id,"epoch":1,"retryable":true,"error":"Push acknowledgement lost"})).unwrap();
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["repository"]["pending"], receipt["id"]);
    assert_eq!(snapshot["repository"]["published_commit"], "a".repeat(40));
    call(&db, json!({"op":"claim","job_id":id})).unwrap();
    call(&db,json!({"op":"finish","job_id":id,"epoch":2,"result":{"commit":"c".repeat(40),"recovered":true}})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["repository"]["pending"],
        Value::Null
    );
}
