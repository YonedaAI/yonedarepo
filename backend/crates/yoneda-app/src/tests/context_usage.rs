use super::*;

fn started() -> NativeStore {
    let db = repo_with_policy(single_agent::policy());
    call(
        &db,
        json!({"op":"start_run","id":"seed","intent":"Establish a requirement",
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]}),
    )
    .unwrap();
    call(&db, json!({"op":"context_publish","record":{"id":"context:colors","kind":"constraint",
        "statement":"Keep the blue brand colors","purpose":"Continuity","intent_id":"intent:seed"}})).unwrap();
    call(&db, json!({"op":"start_run","id":"update","intent":"Update the website","context":["context:colors"],
        "agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"}]})).unwrap();
    call(&db, json!({"op":"claim","job_id":"job:update:agent-1"})).unwrap();
    db
}
fn receipt(call_id: &str, tool: &str, stage: &str) -> Value {
    json!({"op":"record_context_access","job_id":"job:update:agent-1","epoch":1,"call_id":call_id,
        "tool":tool,"stage":stage,"targets":[{"id":"context:colors"}],
        "actor":"spoofed","run_id":"seed","execution_id":"spoofed","headers":{"authorization":"private"}})
}
fn usage(db: &NativeStore) -> Value {
    call(db, json!({"op":"context_usage","run_id":"update"})).unwrap()
}

#[test]
fn assigned_search_and_opened_are_distinct_idempotent_and_attempt_scoped() {
    let db = started();
    let initial = usage(&db);
    assert_eq!(
        initial["counts"],
        json!({"assigned":1,"returned":0,"opened":0,"cited":0,"checked":0,"read_calls":0})
    );
    let search = receipt("search-call", "context_search", "returned");
    let first = call(&db, search.clone()).unwrap();
    assert_eq!(call(&db, search.clone()).unwrap()["seq"], first["seq"]);
    let mut changed = search;
    changed["stage"] = json!("opened");
    assert_eq!(call(&db, changed).unwrap_err().code, "INVALID_INPUT");
    let opened = receipt("open-call", "context_get", "opened");
    call(&db, opened.clone()).unwrap();
    let mut conflict = opened;
    conflict["targets"] = json!([{"id":"intent:seed"}]);
    assert_eq!(
        call(&db, conflict).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
    let page = usage(&db);
    assert_eq!(page["counts"]["returned"], 1);
    assert_eq!(page["counts"]["opened"], 1);
    assert_eq!(page["counts"]["read_calls"], 2);
    assert_eq!(page["entries"][0]["run_id"], "update");
    assert_eq!(page["entries"][0]["execution_id"], "update:agent-1");
    assert_eq!(page["entries"][0]["targets"][0]["authority"], "assertion");
    assert!(!page.to_string().contains("private"));
    assert!(!page.to_string().contains("spoofed"));
    assert_eq!(usage(&db), page); // Query itself never creates receipts.
    assert_eq!(
        call(
            &db,
            json!({"op":"context_usage","job_id":"job:update:agent-1","epoch":1,"run_id":"seed"})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    let mut expired = receipt("expired", "context_get", "opened");
    expired["now"] = json!(999999);
    assert_eq!(call(&db, expired).unwrap_err().code, "FENCED");
    assert_eq!(usage(&db)["counts"]["read_calls"], 2);
}

#[test]
fn usage_pagination_preserves_full_run_counts_and_validates_filters() {
    let db = started();
    for index in 0..105 {
        call(
            &db,
            receipt(&format!("page-{index}"), "context_get", "opened"),
        )
        .unwrap();
    }
    let first = usage(&db);
    assert_eq!(first["entries"].as_array().unwrap().len(), 50);
    assert_eq!(first["has_more"], true);
    assert_eq!(first["counts"]["read_calls"], 105);
    let next = call(
        &db,
        json!({"op":"context_usage","run_id":"update","cursor":first["next_cursor"],"limit":100}),
    )
    .unwrap();
    assert_eq!(next["entries"].as_array().unwrap().len(), 55);
    assert_eq!(next["has_more"], false);
    assert_eq!(next["counts"], first["counts"]);
    assert!(next["entries"][0]["seq"].as_i64().unwrap() > first["next_cursor"].as_i64().unwrap());
    let filtered = call(
        &db,
        json!({"op":"context_usage","run_id":"update","execution_id":"update:agent-1","epoch":2}),
    )
    .unwrap();
    assert_eq!(filtered["entries"], json!([]));
    assert_eq!(filtered["counts"], first["counts"]);
    for input in [
        json!({"limit":101}),
        json!({"cursor":-1}),
        json!({"epoch":0}),
    ] {
        let mut c = json!({"op":"context_usage","run_id":"update"});
        for (key, value) in input.as_object().unwrap() {
            c[key] = value.clone();
        }
        assert_eq!(call(&db, c).unwrap_err().code, "INVALID_INPUT");
    }
    assert_eq!(
        call(
            &db,
            json!({"op":"context_usage","run_id":"update","execution_id":"seed:agent-1"})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
}

#[test]
fn artifact_receipts_follow_verified_delivery_and_commit_compatibility_edges_atomically() {
    let db = repo();
    start(&db);
    call(&db, json!({"op":"claim","job_id":"job:run-one:research"})).unwrap();
    call(&db, json!({"op":"publish_artifact","job_id":"job:run-one:research","epoch":1,
        "id":"artifact:notes","kind":"research","label":"Prior context","digest":"a".repeat(64),
        "metadata":{"assumptions":[{"statement":"Keep bounded requests","metric":"requests","limit":3,"path":"src/main.rs"}]}})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":"job:run-one:research","epoch":1,"result":{}}),
    )
    .unwrap();
    let job = "job:run-one:codex-minimal";
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    call(
        &db,
        json!({"op":"authorize_artifact","job_id":job,"epoch":1,"id":"artifact:notes"}),
    )
    .unwrap();
    assert_eq!(
        call(&db, json!({"op":"context_usage","run_id":"run-one"})).unwrap()["counts"]["read_calls"],
        0
    );
    let mut c = json!({"op":"record_context_access","job_id":job,"epoch":1,"call_id":"artifact-open",
        "tool":"artifact_get","stage":"opened","targets":[{"id":"artifact:notes","digest":"b".repeat(64)}]});
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(call(&db, c.clone()).unwrap_err().code, "DIGEST_MISMATCH");
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
    c["targets"][0]["digest"] = json!("a".repeat(64));
    call(&db, c.clone()).unwrap();
    call(&db, c).unwrap();
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(
        snapshot["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["source"] == "artifact:notes"
                && e["target"] == "run-one:codex-minimal"
                && e["relation"] == "retrieved_by")
    );
    assert_eq!(
        call(&db, json!({"op":"context_usage","run_id":"run-one"})).unwrap()["counts"]["read_calls"],
        1
    );
}

#[test]
fn v7_migration_is_repeatable_preserves_history_and_marks_old_reads_unknown() {
    let db = started();
    let mut run = crate::storage::get(&db, "runs", "update").unwrap();
    run.as_object_mut().unwrap().remove("context_usage_version");
    crate::storage::save(&db, "runs", "update", &run).unwrap();
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    for table in [
        "context_access",
        "context_sessions",
        "context_access_metadata",
    ] {
        db.query(&format!("DROP TABLE {table}"), &[]).unwrap();
    }
    db.query("DROP INDEX context_nodes_by_author", &[]).unwrap();
    db.query("DELETE FROM schema_migrations WHERE version=7", &[])
        .unwrap();
    migrate(&db).unwrap();
    migrate(&db).unwrap();
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
    let page = usage(&db);
    assert_eq!(page["coverage"]["status"], "unavailable");
    assert_eq!(page["counts"]["assigned"], 1);
    call(&db, receipt("newly-recorded", "context_get", "opened")).unwrap();
    assert_eq!(usage(&db)["coverage"]["status"], "partial");
}

#[test]
fn explicit_citation_remains_an_assertion_while_its_candidate_revision_is_independently_checked() {
    let db = started();
    call(&db, json!({"op":"context_publish","job_id":"job:update:agent-1","epoch":1,
        "record":{"id":"context:choice","kind":"proposed_decision","statement":"Keep blue navigation",
        "purpose":"Follow the earlier constraint","links":[{"relation":"supports","target":"context:colors"}]}})).unwrap();
    call(&db, json!({"op":"finish","job_id":"job:update:agent-1","epoch":1,"result":{"workspace":"e".repeat(64)}})).unwrap();
    let capture = "capture:update:agent-1";
    call(&db, json!({"op":"claim","job_id":capture})).unwrap();
    let revision = json!({"repository":"yoneda-dev/fixture-fork","commit":"b".repeat(40)});
    call(&db, json!({"op":"finish","job_id":capture,"epoch":1,"result":{"id":"checked-update",
        "revision":revision,"tree":"f".repeat(40),"paths":["public/index.html"],"diff":"fixture","summary":"Synthetic captured revision"}})).unwrap();
    let evaluator = "evaluate:checked-update";
    call(&db, json!({"op":"claim","job_id":evaluator})).unwrap();
    call(
        &db,
        json!({"op":"register_site","job_id":evaluator,"epoch":1,"digest":"e".repeat(64),
        "files":{"index.html":{"content":"<!doctype html><title>Fixture</title>"}}}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"verify_finish","job_id":evaluator,"epoch":1,"evidence":"e".repeat(64),
        "report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],
        "commands":[{"name":"build","output":{"exit":0}}]}}),
    )
    .unwrap();
    let page = usage(&db);
    assert_eq!(page["counts"]["cited"], 1);
    assert_eq!(page["counts"]["checked"], 1);
    assert_eq!(page["counts"]["opened"], 0); // Citation is not proof of retrieval.
    assert_eq!(page["citations"][0]["authority"], "assertion");
    assert_eq!(page["citations"][0]["epoch"], 1);
    assert_eq!(page["citations"][0]["targets"][0]["id"], "context:colors");
    assert_eq!(page["citations"][0]["candidates"][0]["revision"], revision);
    assert_eq!(
        page["citations"][0]["candidates"][0]["evaluation"]["revision"],
        revision
    );
    assert_eq!(
        page["citations"][0]["candidates"][0]["evaluation"]["authority"],
        "checked_revision"
    );
}

#[test]
fn successful_access_advances_live_sequence_once_and_commits_with_its_receipt() {
    let db = started();
    let before = call(&db, json!({"op":"snapshot"})).unwrap()["seq"]
        .as_i64()
        .unwrap();
    let command = receipt("live-access", "context_get", "opened");
    let recorded = call(&db, command.clone()).unwrap();
    let after = call(&db, json!({"op":"snapshot"})).unwrap()["seq"]
        .as_i64()
        .unwrap();
    assert_eq!(after, before + 1);
    call(&db, command).unwrap();
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap()["seq"], after);
    let events = call(&db, json!({"op":"events","after":before})).unwrap();
    let events = events["events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "context.accessed");
    assert_eq!(events[0]["data"]["receipt_seq"], recorded["seq"]);
    assert_eq!(events[0]["data"]["execution_id"], "update:agent-1");
    assert_eq!(events[0]["data"]["target_count"], 1);
    let outbox = call(&db, json!({"op":"outbox"})).unwrap();
    assert!(
        outbox["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["kind"] == "live"
                && entry["payload"]["event"]["kind"] == "context.accessed")
    );
}
