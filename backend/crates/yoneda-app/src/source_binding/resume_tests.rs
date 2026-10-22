//! A retry reads exactly its own interrupted attempt's staged files, read-only.
use super::*;

fn source_call(source: &NativeStore, actor: &Value, mut c: Value) -> Result<Value> {
    c["now"] = json!(1000);
    c["_source_signing_key"] = json!(KEY);
    c["_actor"] = actor.clone();
    source_workspace::execute_source_workspace(source, c)
}

/// Epoch 1 binds and writes `src/order.js`, then times out; epoch 2 is the live retry.
fn interrupted() -> (NativeStore, NativeStore, Value) {
    let db = db();
    let first = bind(&db);
    let source = NativeStore::memory().unwrap();
    let actor = first["actor_grant"].clone();
    source_call(
        &source,
        &actor,
        json!({"op":"source_init","request_id":"init",
        "binding":first["binding"],"view":view(),"baseline_overrides":[]}),
    )
    .unwrap();
    let bytes = b"export const total = (n) => n * 12;\n";
    let hash = yoneda_agents_core::digest(bytes);
    let ticket = source_call(
        &source,
        &actor,
        json!({"op":"source_upload_ticket",
        "request_id":"ticket","path":"src/order.js","sha256":hash,"size":bytes.len(),
        "mode":"100644","expected_workspace_version":0,"expected_file_version":0}),
    )
    .unwrap();
    source_call(
        &source,
        &actor,
        json!({"op":"source_verify_upload","request_id":"verify",
        "ticket_id":ticket["ticket"]["id"],"sha256":hash,"size":bytes.len()}),
    )
    .unwrap();
    source_call(
        &source,
        &actor,
        json!({"op":"source_create","request_id":"create",
        "path":"src/order.js","ticket_id":ticket["ticket"]["id"],
        "expected_workspace_version":0,"expected_file_version":0}),
    )
    .unwrap();
    let mut job = get(&db, "jobs", "job").unwrap();
    job["epoch"] = json!(2);
    job["resume"] = json!({"workspace_id":first["binding"]["workspace_id"],"epoch":1,
        "reason":"EXECUTION_TIMEOUT","binding":first["binding"]});
    save(&db, "jobs", "job", &job).unwrap();
    (db, source, first)
}

#[test]
fn the_live_retry_reads_its_interrupted_staged_files_through_a_read_only_grant() {
    let (db, source, first) = interrupted();
    let granted = call(
        &db,
        json!({"op":"source_resume_grant","job_id":"job","epoch":2}),
    )
    .unwrap();
    assert_eq!(granted["workspace_id"], first["binding"]["workspace_id"]);
    assert_eq!(granted["reason"], "EXECUTION_TIMEOUT");
    let actor = granted["actor_grant"].clone();
    assert_eq!(actor["claims"]["access"], "read_only");
    assert_eq!(actor["claims"]["purpose"], "supervisor");
    let staged = source_call(&source, &actor, json!({"op":"source_staged_changes"})).unwrap();
    assert_eq!(staged["items"].as_array().unwrap().len(), 1);
    assert_eq!(staged["items"][0]["path"], "src/order.js");
    assert_eq!(staged["items"][0]["after"]["content"]["kind"], "r2");
    // The grant can read the old attempt but never write to it.
    let write = source_call(
        &source,
        &actor,
        json!({"op":"source_delete","request_id":"del",
        "path":"src/order.js","expected_workspace_version":1,"expected_file_version":1}),
    );
    assert_eq!(write.unwrap_err().code, "FORBIDDEN");
    // The model-facing source purpose cannot enumerate staged deltas.
    let binding: SourceBinding = serde_json::from_value(first["binding"].clone()).unwrap();
    let model =
        source_workspace::sign_read_actor(&binding, 50_000, ActorPurpose::Source, KEY).unwrap();
    let denied = source_call(
        &source,
        &json!(model),
        json!({"op":"source_staged_changes"}),
    );
    assert_eq!(denied.unwrap_err().code, "FORBIDDEN");
}

#[test]
fn stale_epochs_and_foreign_checkpoints_are_fenced() {
    let (db, _, _) = interrupted();
    assert_eq!(
        call(
            &db,
            json!({"op":"source_resume_grant","job_id":"job","epoch":1})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    let mut job = get(&db, "jobs", "job").unwrap();
    job["resume"]["binding"]["execution_id"] = json!("another-execution");
    save(&db, "jobs", "job", &job).unwrap();
    assert!(
        call(
            &db,
            json!({"op":"source_resume_grant","job_id":"job","epoch":2})
        )
        .is_err()
    );
    job["resume"] = Value::Null;
    save(&db, "jobs", "job", &job).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"source_resume_grant","job_id":"job","epoch":2})
        )
        .unwrap_err()
        .code,
        "NOT_FOUND"
    );
}
