use super::*;

#[test]
fn logs_derive_identity_drop_private_fields_and_fence_expired_attempts() {
    let db = repo();
    start(&db);
    let claim = call(&db, json!({"op":"claim","job_id":"job:run-one:research"})).unwrap();
    let command = json!({"op":"record_execution_log","job_id":claim["id"],"epoch":claim["epoch"],
        "event_id":"fixture-log","stage":"model.rejected","error_code":"PROVIDER_CONFIGURATION",
        "execution_id":"spoofed","provider":"spoofed","headers":{"authorization":"secret"},"message":"secret"});
    let first = call(&db, command.clone()).unwrap();
    assert_eq!(call(&db, command.clone()).unwrap(), first);
    let logs = call(
        &db,
        json!({"op":"execution_logs","execution_id":"run-one:research"}),
    )
    .unwrap();
    assert_eq!(logs["entries"].as_array().unwrap().len(), 1);
    let data = &logs["entries"][0]["data"];
    assert_eq!(data["execution_id"], "run-one:research");
    assert_eq!(data["provider"], claim["payload"]["execution"]["harness"]);
    assert!(!logs.to_string().contains("secret"));
    assert!(!logs.to_string().contains("spoofed"));
    let mut conflict = command.clone();
    conflict["http_status"] = json!(409);
    assert_eq!(
        call(&db, conflict).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
    assert_eq!(
        call(&db, json!({"op":"execution_logs","execution_id":"absent"}))
            .unwrap_err()
            .code,
        "NOT_FOUND"
    );
    let mut expired = command;
    expired["now"] = json!(999999);
    assert_eq!(call(&db, expired).unwrap_err().code, "FENCED");
}

#[test]
fn log_migration_upgrades_v5_without_changing_graph_history() {
    let db = repo();
    start(&db);
    let before = call(&db, json!({"op":"events"})).unwrap();
    db.query("DROP TABLE execution_logs", &[]).unwrap();
    db.query("DELETE FROM schema_migrations WHERE version=6", &[])
        .unwrap();
    migrate(&db).unwrap();
    migrate(&db).unwrap();
    assert_eq!(call(&db, json!({"op":"events"})).unwrap(), before);
    assert_eq!(
        call(
            &db,
            json!({"op":"execution_logs","execution_id":"run-one:research"})
        )
        .unwrap()["entries"],
        json!([])
    );
}

#[test]
fn log_cursor_pages_without_skipping_or_repeating_entries() {
    let db = repo();
    start(&db);
    call(&db, json!({"op":"claim","job_id":"job:run-one:research"})).unwrap();
    for index in 0..105 {
        call(
            &db,
            json!({"op":"record_execution_log","job_id":"job:run-one:research","epoch":1,
            "event_id":format!("page-{index}"),"stage":"model.request_started"}),
        )
        .unwrap();
    }
    let first = call(
        &db,
        json!({"op":"execution_logs","execution_id":"run-one:research"}),
    )
    .unwrap();
    assert_eq!(first["entries"].as_array().unwrap().len(), 100);
    assert_eq!(first["has_more"], true);
    let second = call(
        &db,
        json!({"op":"execution_logs","execution_id":"run-one:research","after":first["next"]}),
    )
    .unwrap();
    assert_eq!(second["entries"].as_array().unwrap().len(), 5);
    assert_eq!(second["has_more"], false);
    assert!(second["entries"][0]["seq"].as_i64().unwrap() > first["next"].as_i64().unwrap());
}
