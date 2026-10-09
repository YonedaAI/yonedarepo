use super::*;

fn delete(db: &NativeStore) -> Value {
    call(
        db,
        json!({"op":"delete_repository","_workspace":"_admin","confirm_name":"Retry client"}),
    )
    .unwrap()
}

#[test]
fn deletion_fences_active_work_and_remains_idempotent() {
    let db = repo();
    start(&db);
    let job = call(&db, json!({"op":"claim","job_id":"job:run-one:research"})).unwrap();
    let result = delete(&db);
    assert_eq!(result["status"], "deleted");
    assert_eq!(result["cleanup_pending"], true);
    assert_eq!(delete(&db), result);
    let stored = crate::storage::get(&db, "jobs", job["id"].as_str().unwrap()).unwrap();
    assert_eq!(stored["status"], "cancelled");
    assert_eq!(stored["epoch"], 2);
    for command in [
        json!({"op":"snapshot"}),
        json!({"op":"graph","id":"repo-test"}),
        json!({"op":"heartbeat","job_id":job["id"],"epoch":1}),
        json!({"op":"finish","job_id":job["id"],"epoch":1,"result":{}}),
        json!({"op":"start_run","id":"late-run","intent":"Try to revive"}),
        json!({"op":"init"}),
    ] {
        assert_eq!(call(&db, command).unwrap_err().code, "REPOSITORY_DELETED");
    }
    assert_eq!(
        call(&db, json!({"op":"claim","job_id":job["id"]})).unwrap()["already_done"],
        true
    );
    assert_eq!(
        call(&db, json!({"op":"recover","now":99999999})).unwrap()["recovered"],
        0
    );
    let pending = call(&db, json!({"op":"outbox"})).unwrap();
    let entries = pending["jobs"].as_array().unwrap();
    assert!(
        entries
            .iter()
            .any(|entry| entry["kind"] == "stop" && entry["payload"]["epoch"] == 1)
    );
    assert!(!entries.iter().any(|entry| entry["kind"] == "agent"));
    assert!(
        entries.iter().any(|entry| entry["kind"] == "index"
            && entry["payload"]["repository"]["status"] == "deleted")
    );
    assert!(
        !entries
            .iter()
            .any(|entry| entry["kind"] == "delete_artifact")
    );
}

#[test]
fn deletion_confirmation_and_ownership_fail_without_mutation() {
    let db = repo();
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"delete_repository","_workspace":"alice","confirm_name":"Retry client"})
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"delete_repository","_workspace":"_admin","confirm_name":"retry client"})
        )
        .unwrap_err()
        .code,
        "INVALID_INPUT"
    );
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
}

#[test]
fn deletion_fences_a_pending_publication_without_accepting_late_readback() {
    let db = repo();
    let decision = call(&db, ready(&db)).unwrap();
    let id = format!("publish:{}", decision["id"].as_str().unwrap());
    let attempt = call(&db, json!({"op":"claim","job_id":id})).unwrap();
    delete(&db);
    assert_eq!(crate::storage::repo(&db).unwrap()["pending"], Value::Null);
    assert_eq!(call(&db, json!({"op":"finish","job_id":id,"epoch":attempt["epoch"],"result":{"commit":"c".repeat(40)}})).unwrap_err().code, "REPOSITORY_DELETED");
    assert_eq!(
        crate::storage::repo(&db).unwrap()["published_commit"],
        "a".repeat(40)
    );
}

#[test]
fn deleting_an_uninitialized_project_permanently_reserves_its_identity() {
    let db = NativeStore::memory().unwrap();
    let deletion = json!({"op":"delete_repository","id":"repo-pending","_workspace":"alice","confirm_name":"Pending","namespace":"yoneda-dev","project":{"id":"repo-pending","name":"Pending"}});
    let result = call(&db, deletion.clone()).unwrap();
    assert_eq!(result["status"], "deleted");
    assert_eq!(call(&db, deletion).unwrap(), result);
    assert_eq!(
        call(&db, json!({"op":"init"})).unwrap_err().code,
        "REPOSITORY_DELETED"
    );
    let pending = call(&db, json!({"op":"outbox"})).unwrap();
    assert!(
        pending["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["kind"] == "delete_artifact"
                && entry["payload"]["name"] == "repo-pending")
    );
}
