use super::*;
use crate::native::NativeStore;
use serde_json::json;

#[path = "tests/context_intent.rs"]
mod context_intent;
#[path = "tests/context_sessions.rs"]
mod context_sessions;
#[path = "tests/context_study.rs"]
mod context_study;
#[path = "tests/context_usage.rs"]
mod context_usage;
#[path = "tests/delegation.rs"]
mod delegation;
#[path = "tests/deletion.rs"]
mod deletion;
#[path = "tests/execution_logs.rs"]
mod execution_logs;
mod git_transport;
#[path = "tests/graph_status.rs"]
mod graph_status;
#[path = "tests/model_budgets.rs"]
mod model_budgets;
#[path = "tests/product_runs.rs"]
mod product_runs;
#[path = "tests/published_continuation.rs"]
mod published_continuation;
#[path = "tests/reliability.rs"]
mod reliability;
#[path = "tests/restarts.rs"]
mod restarts;
#[path = "tests/single_agent.rs"]
mod single_agent;

fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    if c.get("now").is_none() {
        c["now"] = json!(1000);
    }
    execute(db, c)
}
fn repo() -> NativeStore {
    repo_with_policy(serde_json::to_value(yoneda_core::Policy::default()).unwrap())
}
fn repo_with_policy(policy: Value) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"init","id":"repo-test","name":"Retry client","remote":{"namespace":"yoneda-dev","name":"retry"},"commit":"a".repeat(40),"policy":policy})).unwrap();
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
    call(&db, json!({"op":"recover","now":122000})).unwrap();
    let second = call(&db, json!({"op":"claim","job_id":job,"now":122000})).unwrap();
    assert_eq!(second["epoch"], 2);
    assert_eq!(
        call(
            &db,
            json!({"op":"finish","job_id":job,"epoch":1,"now":122001,"result":{}})
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
fn captured(db: &NativeStore) {
    start(db);
    let research = "job:run-one:research";
    call(db, json!({"op":"claim","job_id":research})).unwrap();
    call(db,json!({"op":"publish_artifact","job_id":research,"epoch":1,"id":"research-a","digest":"b".repeat(64),"label":"Research","kind":"research","metadata":{"assumptions":[{"statement":"Upstream p99 stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]}})).unwrap();
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
}
fn ready(db: &NativeStore) -> Value {
    captured(db);
    let eval = "evaluate:candidate-a";
    call(db, json!({"op":"claim","job_id":eval})).unwrap();
    let policy = crate::storage::repo(db).unwrap()["policy"].clone();
    let evaluation = json!({"id":"evaluation-a","candidate":"candidate-a","revision":{"repository":"yoneda-dev/fork-a","commit":"cccccccccccccccccccccccccccccccccccccccc"},"policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],"evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"compiled"},{"name":"behavior","status":"pass","detail":"verified"}]});
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
    assert_eq!(call(&db,json!({"op":"why","commit":"cccccccccccccccccccccccccccccccccccccccc","path":"src/retry.rs"})).unwrap()["coverage"],"unknown");
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
        json!([{"version":1},{"version":2},{"version":3},{"version":4},{"version":5},{"version":6},{"version":7},{"version":8},{"version":9},{"version":10},{"version":11},{"version":12}])
            .as_array()
            .unwrap()
            .clone()
    );
    migrate(&db).unwrap();
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM schema_migrations", &[])
            .unwrap()[0]["count"],
        12
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

#[path = "tests/history.rs"]
mod history_tests;

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
    call(&db, json!({"op":"recover","now":122000})).unwrap();
    call(&db, json!({"op":"claim","job_id":job,"now":122000})).unwrap();
    call(&db, json!({"op":"recover","now":244000})).unwrap();
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
    call(&db,json!({"op":"publish_artifact","job_id":id,"epoch":1,"id":"research","digest":"b".repeat(64),"label":"Research","kind":"research","metadata":{"assumptions":[{"statement":"Upstream p99 stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]}})).unwrap();
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
    call(&db,json!({"op":"publish_artifact","job_id":research,"epoch":1,"id":"shared","digest":"b".repeat(64),"label":"Shared research","kind":"research","metadata":{"assumptions":[{"statement":"Upstream p99 stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]}})).unwrap();
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

#[test]
fn observation_id_collision_preserves_the_original_assumption() {
    let db = repo();
    crate::storage::node(
        &db,
        "original",
        "assumption",
        "Original statement",
        "agent_assertion",
        1000,
        json!({"statement":"Original statement","metric":"latency","limit":100}),
    )
    .unwrap();
    assert_eq!(call(&db,json!({"op":"observe","id":"original","assumption":"original","metric":"latency","value":150,"simulated":true})).unwrap_err().code,"ALREADY_EXISTS");
    assert_eq!(
        crate::storage::get(&db, "nodes", "original").unwrap()["kind"],
        "assumption"
    );
}
#[test]
fn history_starts_at_the_requested_root_after_global_snapshot_limits() {
    let db = repo();
    for index in 0..2100 {
        crate::storage::node(
            &db,
            &format!("node-{index:05}"),
            "context",
            "Context",
            "agent_assertion",
            1000,
            json!({}),
        )
        .unwrap();
    }
    let graph = call(&db, json!({"op":"graph","id":"node-02099"})).unwrap();
    assert_eq!(graph["nodes"][0]["id"], "node-02099");
    assert_eq!(graph["truncated"], false);
}

#[test]
fn policy_upgrade_preserves_old_evidence_and_requires_fresh_checks() {
    let legacy = json!({"version":"retry-v1","suite":"retry-contract-v1","environment":"rust-1.94-evaluator-v1","required_checks":["build","behavior"]});
    let db = repo_with_policy(legacy);
    let selection = ready(&db);
    call(&db,json!({"op":"update_policy","expected_commit":"a".repeat(40),"expected_version":0,"expected_policy":"retry-v1","policy":yoneda_core::Policy::default()})).unwrap();
    assert_eq!(
        call(&db, selection.clone()).unwrap_err().code,
        "EVIDENCE_MISMATCH"
    );
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["evaluations"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["candidates"][0]["status"], "evaluating");
    let job = "evaluate:candidate-a:retry-v2";
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    let mut report = json!({"build":{"exit":0},"cases":yoneda_core::retry::cases().iter().map(|c|json!({"input":c,"exit":0,"actual":yoneda_core::retry::expected(c)})).collect::<Vec<_>>()});
    report["environment"] = json!("rust-1.94-evaluator-v1");
    report["suite"] = json!("retry-contract-v2");
    assert!(call(&db,json!({"op":"verify_finish","job_id":job,"epoch":1,"evidence":"e".repeat(64),"report":report})).is_err());
    report["environment"] = json!(yoneda_core::Policy::default().environment);
    call(&db,json!({"op":"verify_finish","job_id":job,"epoch":1,"evidence":"e".repeat(64),"report":report})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["evaluations"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        call(&db, selection).unwrap()["status"],
        "publication_pending"
    );
}

#[test]
fn cold_container_boot_has_time_to_start_before_runtime_lease_begins() {
    let db = repo();
    start(&db);
    let id = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":id})).unwrap();
    call(&db,json!({"op":"progress","job_id":id,"epoch":1,"now":100000,"progress":{"stage":"container_ready"}})).unwrap();
    call(
        &db,
        json!({"op":"heartbeat","job_id":id,"epoch":1,"now":120000}),
    )
    .unwrap();
}

#[test]
fn research_assumptions_must_have_a_structured_queryable_contract() {
    let db = repo();
    start(&db);
    let job = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    let mut publish = json!({"op":"publish_artifact","job_id":job,"epoch":1,"id":"research-contract","digest":"b".repeat(64),"label":"Research","kind":"research","metadata":{"assumption":"upstream_p99_ms <= 100","metric":100,"integer_limit":10,"path":"src/main.rs"}});
    assert!(call(&db, publish.clone()).is_err());
    publish["metadata"] = json!({"assumptions":[{"statement":"Upstream p99 stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]});
    call(&db, publish.clone()).unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(
        s["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["kind"] == "assumption" && n["data"]["limit"] == 100)
    );
    publish["id"] = json!("wrong-type");
    publish["metadata"]["assumptions"][0]["limit"] = json!("100");
    assert!(call(&db, publish).is_err());
}

#[test]
fn automated_fixture_selection_is_not_labelled_as_a_human_decision() {
    let db = repo();
    let mut selection = ready(&db);
    selection["decision_kind"] = json!("development_verification");
    selection["rationale"] = json!("Automated development fixture verification; not user approval");
    let receipt = call(&db, selection).unwrap();
    let decision = call(&db, json!({"op":"decision","id":receipt["id"]})).unwrap();
    assert_eq!(decision["decision_kind"], "development_verification");
    let graph = call(&db, json!({"op":"graph","id":receipt["id"]})).unwrap();
    let selected = graph["edges"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["relation"] == "selected_by")
        .unwrap();
    assert_eq!(selected["evidence"], "automated development verification");
}

#[test]
fn artifact_uuid_alias_resolves_only_inside_the_frozen_context() {
    let db = repo();
    start(&db);
    let research = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":research})).unwrap();
    let uuid = "6cf12bf4-792f-4449-bfe6-d8bbece773f8";
    call(&db,json!({"op":"publish_artifact","job_id":research,"epoch":1,"id":format!("artifact:{uuid}"),"digest":"b".repeat(64),"label":"Research","kind":"research","metadata":{"assumptions":[{"statement":"Upstream p99 stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]}})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":research,"epoch":1,"result":{}}),
    )
    .unwrap();
    let coding = "job:run-one:codex-minimal";
    call(&db, json!({"op":"claim","job_id":coding})).unwrap();
    let authorized = call(
        &db,
        json!({"op":"authorize_artifact","job_id":coding,"epoch":1,"id":uuid}),
    )
    .unwrap();
    assert_eq!(authorized["id"], format!("artifact:{uuid}"));
    let before = call(&db, json!({"op":"events","after":0})).unwrap();
    assert!(
        !before["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "artifact.retrieved")
    );
    let artifact = call(
        &db,
        json!({"op":"get_artifact","job_id":coding,"epoch":1,"id":uuid}),
    )
    .unwrap();
    assert_eq!(artifact["id"], format!("artifact:{uuid}"));
    assert_eq!(call(&db,json!({"op":"get_artifact","job_id":coding,"epoch":1,"id":"fbc7cadb-e6bc-4e75-bb91-f00cdd612321"})).unwrap_err().code,"FORBIDDEN");
    let events = call(&db, json!({"op":"events","after":0})).unwrap();
    assert!(
        events["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "artifact.retrieved"
                && e["data"]["artifact"] == artifact["id"]
                && e["data"]["epoch"] == 1)
    );
}

mod sites;
mod team;

mod external;

#[path = "tests/team_planning.rs"]
mod team_planning;
