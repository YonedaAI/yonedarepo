use super::*;
use crate::SqlStore;

fn delete(db: &NativeStore, run: &str) -> Result<Value> {
    call(
        db,
        json!({"op":"delete_run","run_id":run,"_workspace":"_admin","now":5000}),
    )
}

/// Every stored row, rendered as text, that still mentions `needle`.
fn mentions(db: &NativeStore, needle: &str) -> Vec<String> {
    let tables = db
        .query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            &[],
        )
        .unwrap();
    let mut found = Vec::new();
    for table in tables.iter().filter_map(|row| row["name"].as_str()) {
        for row in db.query(&format!("SELECT * FROM {table}"), &[]).unwrap() {
            let text = row.to_string();
            if text.contains(needle) {
                found.push(format!("{table}: {text}"));
            }
        }
    }
    found
}

/// Run `id` builds one checked candidate `<id>-candidate` at `commit`.
fn checked(db: &NativeStore, id: &str, commit: &str, branch: Option<(&str, i64)>) {
    let mut start =
        json!({"op":"start_run","id":id,"intent":"Implement registration","agents":one_agent()});
    if let Some((head, version)) = branch {
        start["working_branch_id"] = json!("development");
        start["expected_working_commit"] = json!(head);
        start["expected_working_version"] = json!(version);
    }
    call(db, start).unwrap();
    let coding = format!("job:{id}:agent-1");
    call(db, json!({"op":"claim","job_id":coding})).unwrap();
    let candidate = format!("{id}-candidate");
    let revision = json!({"repository":"yoneda-dev/retry","commit":commit});
    run_kit::land(
        db,
        &coding,
        1000,
        json!({"id":candidate,"revision":revision,"tree":"d".repeat(40),"paths":["src/booking.rs"],"summary":"Registration implemented"}),
    );
    let evaluator = format!("evaluate:{candidate}");
    call(db, json!({"op":"claim","job_id":evaluator})).unwrap();
    let policy = crate::storage::repo(db).unwrap()["policy"].clone();
    call(db, json!({"op":"finish","job_id":evaluator,"epoch":1,"result":{"id":format!("{id}-evaluation"),"candidate":candidate,"revision":revision,"policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],"evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"compiled"},{"name":"behavior","status":"pass","detail":"verified"}]}})).unwrap();
}

#[test]
fn deletes_every_row_keyed_to_the_run_and_leaves_other_runs() {
    let db = repo();
    start(&db);
    let producer = "job:run-one:agent-1";
    call(&db, json!({"op":"claim","job_id":producer})).unwrap();
    call(&db, json!({"op":"publish_artifact","job_id":producer,"epoch":1,"id":"run-one-notes","digest":"b".repeat(64),"label":"Notes","kind":"notes","metadata":{"assumptions":[{"statement":"Upstream p99 stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/main.rs"}]}})).unwrap();
    call(&db, json!({"op":"observe","id":"run-one-observation","assumption":"assumption:run-one-notes:0","metric":"upstream_p99_ms","value":120})).unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"run-one"})).unwrap();
    checked(&db, "keep", &"c".repeat(40), None);
    let kept = call(&db, json!({"op":"run_detail","run_id":"keep"})).unwrap();
    let repository = crate::storage::repo(&db).unwrap();
    db.query("UPDATE outbox SET delivered=1", &[]).unwrap();
    assert!(!mentions(&db, "run-one").is_empty());

    assert_eq!(
        delete(&db, "run-one").unwrap(),
        json!({"run_id":"run-one","deleted":true})
    );

    let left = mentions(&db, "run-one");
    // Only the deletion notice and the adapter's cleanup request name the run.
    assert!(
        left.iter().all(
            |row| row.starts_with("events: ") && row.contains("run.deleted")
                || row.starts_with("outbox: ")
                    && (row.contains("run_delete") || row.contains("run.deleted"))
        ),
        "{left:#?}"
    );
    let cleanup = call(&db, json!({"op":"outbox"})).unwrap()["jobs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["kind"] == "run_delete")
        .cloned()
        .unwrap();
    assert_eq!(
        cleanup["payload"]["archive_key"],
        "history/repo-test/run-one.json"
    );
    let after = call(&db, json!({"op":"run_detail","run_id":"keep"})).unwrap();
    // Only the event watermark moves for a run the deletion left alone.
    for (key, value) in kept
        .as_object()
        .unwrap()
        .iter()
        .filter(|(key, _)| *key != "seq")
    {
        assert_eq!(after[key], *value, "{key}");
    }
    assert_eq!(crate::storage::repo(&db).unwrap(), repository);
    let page = call(&db, json!({"op":"runs_page"})).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["id"], "keep");
    assert_eq!(delete(&db, "run-one").unwrap_err().code, "NOT_FOUND");
}

#[test]
fn refuses_active_runs_and_callers_other_than_the_owner() {
    let db = repo();
    start(&db);
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    let error = delete(&db, "run-one").unwrap_err();
    assert_eq!(error.code, "INVALID_STATE");
    assert_eq!(error.message, "Cancel the run before deleting it");
    for authority in [
        json!({}),
        json!({"_workspace":"bob"}),
        json!({"_workspace":"_admin","_grant":"agent"}),
        json!({"_workspace":"_admin","_reviewer":true}),
    ] {
        let mut command = json!({"op":"delete_run","run_id":"run-one"});
        command
            .as_object_mut()
            .unwrap()
            .extend(authority.as_object().unwrap().clone());
        assert_eq!(call(&db, command).unwrap_err().code, "FORBIDDEN");
    }
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
}

fn branch_with_checked_run(db: &NativeStore) {
    call(db, json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    checked(db, "run-one", &"c".repeat(40), Some((&"a".repeat(40), 0)));
    select_on_branch(db, "run-one", "run-one-candidate", &"a".repeat(40), 0);
}

#[test]
fn refuses_a_run_whose_unpublished_result_later_work_builds_on() {
    let db = repo();
    branch_with_checked_run(&db);
    let error = delete(&db, "run-one").unwrap_err();
    assert_eq!(error.code, "RUN_DEPENDED_ON");
    assert!(error.message.starts_with("Working branch development"));
    call(&db,json!({"op":"start_run","id":"feature","intent":"Add a waitlist","working_branch_id":"development","expected_working_commit":"c".repeat(40),"expected_working_version":1,"agents":one_agent()})).unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"feature"})).unwrap();
    let error = delete(&db, "run-one").unwrap_err();
    assert_eq!(error.code, "RUN_DEPENDED_ON");
    assert!(error.message.starts_with("Run feature"));
    assert!(crate::storage::get(&db, "runs", "run-one").is_ok());
}

#[test]
fn published_run_deletes_without_moving_canonical_source() {
    let db = repo();
    branch_with_checked_run(&db);
    call(&db,json!({"op":"start_run","id":"feature","intent":"Add a waitlist","working_branch_id":"development","expected_working_commit":"c".repeat(40),"expected_working_version":1,"agents":one_agent()})).unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"feature"})).unwrap();
    let decision = call(&db,json!({"op":"accept","request_id":"publish-branch","candidate":"run-one-candidate","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Registration behavior is independently checked","alternatives":[]})).unwrap();
    let pending = delete(&db, "run-one").unwrap_err();
    assert_eq!(pending.code, "INVALID_STATE");
    assert!(pending.message.contains("publication"));
    call(
        &db,
        json!({"op":"publication_readback","decision_id":decision["id"],"observed_commit":"c".repeat(40)}),
    )
    .unwrap();
    let repository = crate::storage::repo(&db).unwrap();
    assert_eq!(repository["published_commit"], "c".repeat(40));

    delete(&db, "run-one").unwrap();

    assert_eq!(crate::storage::repo(&db).unwrap(), repository);
    let branch = call(&db, json!({"op":"working_branch","id":"development"})).unwrap();
    assert_eq!(branch["working_commit"], "c".repeat(40));
    assert_eq!(branch["latest_candidate_id"], Value::Null);
    assert!(crate::storage::get(&db, "runs", "feature").is_ok());
    assert!(crate::storage::get(&db, "decisions", decision["id"].as_str().unwrap()).is_err());
    let next = call(&db,json!({"op":"start_run","id":"next","intent":"Add reminders","working_branch_id":"development","expected_working_commit":"c".repeat(40),"expected_working_version":1,"agents":one_agent()})).unwrap();
    assert_eq!(next["base"]["commit"], "c".repeat(40));
    assert_eq!(delete(&db, "run-one").unwrap_err().code, "NOT_FOUND");
}
