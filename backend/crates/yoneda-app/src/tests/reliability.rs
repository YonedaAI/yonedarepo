use super::*;

fn blocked(db: &NativeStore, conflict: bool) -> Value {
    let receipt = call(db, ready(db)).unwrap();
    let id = format!("publish:{}", receipt["id"].as_str().unwrap());
    call(db, json!({"op":"claim","job_id":id})).unwrap();
    if conflict {
        call(db,json!({"op":"finish","job_id":id,"epoch":1,"result":{"conflict":true,"commit":"f".repeat(40)}})).unwrap();
    } else {
        call(db,json!({"op":"fail","job_id":id,"epoch":1,"retryable":false,"error":"Acknowledgement lost"})).unwrap();
    }
    json!({"op":"resync_repository","_workspace":"_admin","observed_commit":"f".repeat(40),"expected_version":1,"expected_pending":receipt["id"]})
}

#[test]
fn owner_resync_preserves_conflict_audit_and_clears_stale_site() {
    let db = repo();
    let request = blocked(&db, true);
    db.query(
        "UPDATE repository SET payload=json_set(payload,'$.site',json(?))",
        &[json!(
            json!({"commit":"a".repeat(40),"digest":"b".repeat(64)}).to_string()
        )],
    )
    .unwrap();
    let recovered = call(&db, request.clone()).unwrap();
    assert_eq!(recovered["status"], "ready");
    assert_eq!(recovered["version"], 2);
    assert_eq!(recovered["head_commit"], "f".repeat(40));
    assert_eq!(recovered["published_commit"], recovered["head_commit"]);
    assert_eq!(recovered["pending"], Value::Null);
    assert_eq!(recovered["site"], Value::Null);
    assert_eq!(call(&db, request.clone()).unwrap(), recovered);
    let decision = call(&db, json!({"op":"decision","id":"decision:request-a"})).unwrap();
    assert_eq!(decision["status"], "publication_conflict");
    assert_eq!(decision["observed"]["commit"], "f".repeat(40));
    call(
        &db,
        json!({"op":"start_run","id":"after-resync","intent":"Continue from observed remote"}),
    )
    .unwrap();
    db.query("UPDATE repository SET payload=json_set(payload,'$.version',3,'$.head_commit',?,'$.published_commit',?)", &[json!("d".repeat(40)),json!("d".repeat(40))]).unwrap();
    assert_eq!(call(&db, request).unwrap_err().code, "HEAD_MOVED");
}

#[test]
fn owner_resync_recognizes_success_after_acknowledgement_loss_and_fences_publisher() {
    let db = repo();
    let mut request = blocked(&db, false);
    // Simulate a still-running superseded publisher at the recovery boundary.
    db.query("UPDATE jobs SET payload=json_set(payload,'$.status','running','$.lease_until',121000) WHERE id='publish:decision:request-a'", &[]).unwrap();
    request["observed_commit"] = json!("c".repeat(40));
    let recovered = call(&db, request).unwrap();
    assert_eq!(recovered["published_commit"], "c".repeat(40));
    assert_eq!(recovered["head_commit"], recovered["published_commit"]);
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["decisions"][0]["status"], "published");
    assert!(
        snapshot["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["relation"] == "published_as")
    );
    let job = crate::storage::get(&db, "jobs", "publish:decision:request-a").unwrap();
    assert_eq!(job["status"], "cancelled");
    assert_eq!(job["epoch"], 2);
    assert_eq!(
        call(
            &db,
            json!({"op":"finish","job_id":job["id"],"epoch":1,"result":{"commit":"c".repeat(40)}})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    assert!(
        !db.query(
            "SELECT id FROM outbox WHERE id='stop:publish:decision:request-a:1'",
            &[]
        )
        .unwrap()
        .is_empty()
    );
    let graph = call(&db, json!({"op":"graph","id":"decision:request-a"})).unwrap();
    assert!(
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == "decision:request-a" && n["data"] == snapshot["decisions"][0])
    );
}

#[test]
fn owner_resync_requires_owner_explicit_cas_and_blocked_state() {
    let db = repo();
    let request = blocked(&db, false);
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    for (field, value, code) in [
        ("_workspace", json!("other"), "FORBIDDEN"),
        ("_grant", json!("external"), "FORBIDDEN"),
        ("expected_version", json!(0), "HEAD_MOVED"),
        ("expected_pending", Value::Null, "HEAD_MOVED"),
        ("observed_commit", json!("invalid"), "INVALID_INPUT"),
    ] {
        let mut invalid = request.clone();
        invalid[field] = value;
        assert_eq!(call(&db, invalid).unwrap_err().code, code);
        assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
    }
    for field in ["_workspace", "expected_pending", "expected_version"] {
        let mut invalid = request.clone();
        invalid.as_object_mut().unwrap().remove(field);
        assert_eq!(call(&db, invalid).unwrap_err().code, "INVALID_INPUT");
    }
    let clean = repo();
    assert_eq!(call(&clean,json!({"op":"resync_repository","_workspace":"_admin","expected_version":0,"expected_pending":null,"observed_commit":"a".repeat(40)})).unwrap_err().code,"INVALID_STATE");
}

#[test]
fn capacity_defer_refunds_once_fences_epoch_and_enforces_durable_delay() {
    let db = repo();
    start(&db);
    let id = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":id})).unwrap();
    let request = json!({"op":"defer_job","job_id":id,"epoch":1,"reason":"container_capacity"});
    let deferred = call(&db, request.clone()).unwrap();
    assert_eq!(deferred["attempt"], 0);
    assert_eq!(deferred["epoch"], 2);
    assert_eq!(deferred["status"], "queued");
    assert_eq!(deferred["not_before"], 6000);
    assert_eq!(call(&db, request).unwrap_err().code, "FENCED");
    assert_eq!(
        call(&db, json!({"op":"check_attempt","job_id":id,"epoch":1}))
            .unwrap_err()
            .code,
        "FENCED"
    );
    assert_eq!(
        call(&db, json!({"op":"claim","job_id":id,"now":5999})).unwrap()["deferred"],
        true
    );
    assert_eq!(
        call(&db, json!({"op":"recover","now":5999})).unwrap()["recovered"],
        0
    );
    let outbox = db
        .query(
            "SELECT payload FROM outbox WHERE id=?",
            &[json!(format!("dispatch:{id}:defer:2"))],
        )
        .unwrap();
    let dispatch: Value = serde_json::from_str(outbox[0]["payload"].as_str().unwrap()).unwrap();
    assert_eq!(dispatch["not_before"], 6000);
    let next = call(&db, json!({"op":"claim","job_id":id,"now":6000})).unwrap();
    assert_eq!(next["epoch"], 3);
    assert_eq!(next["attempt"], 1);
    let second = call(
        &db,
        json!({"op":"defer_job","job_id":id,"epoch":3,"now":6000,"reason":"container_capacity"}),
    )
    .unwrap();
    assert_eq!(second["not_before"], 16000);
    assert_eq!(second["attempt"], 0);
    assert_eq!(
        call(&db, json!({"op":"defer_job","job_id":id,"epoch":1}))
            .unwrap_err()
            .code,
        "FENCED"
    );
    assert_eq!(
        crate::storage::get(&db, "executions", "run-one:research").unwrap()["status"],
        "queued"
    );
    call(&db, json!({"op":"recover","now":1201000})).unwrap();
    assert_eq!(
        crate::storage::get(&db, "jobs", id).unwrap()["status"],
        "failed"
    );
}

#[test]
fn capacity_defer_rejects_unknown_failure_or_started_runtime_without_refund() {
    let db = repo();
    start(&db);
    let id = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":id})).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"defer_job","job_id":id,"epoch":1,"reason":"boot_failed"})
        )
        .unwrap_err()
        .code,
        "INVALID_INPUT"
    );
    call(
        &db,
        json!({"op":"progress","job_id":id,"epoch":1,"progress":{"stage":"container_ready"}}),
    )
    .unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"defer_job","job_id":id,"epoch":1,"reason":"container_capacity"})
        )
        .unwrap_err()
        .code,
        "INVALID_STATE"
    );
    assert_eq!(crate::storage::get(&db, "jobs", id).unwrap()["attempt"], 1);
}

#[test]
fn resync_without_pending_fences_orphaned_publishers_and_does_not_reblock() {
    let db = repo();
    blocked(&db, false);
    db.query(
        "UPDATE repository SET payload=json_set(payload,'$.pending',null)",
        &[],
    )
    .unwrap();
    db.query("UPDATE jobs SET payload=json_set(payload,'$.status','queued') WHERE id='publish:decision:request-a'", &[]).unwrap();
    let request = json!({"op":"resync_repository","_workspace":"_admin","expected_version":1,
        "expected_pending":null,"observed_commit":"a".repeat(40)});
    call(&db, request.clone()).unwrap();
    assert_eq!(
        crate::storage::get(&db, "jobs", "publish:decision:request-a").unwrap()["status"],
        "cancelled"
    );
    call(&db, json!({"op":"recover","now":1201000})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"repository_status"})).unwrap()["status"],
        "ready"
    );
    assert_eq!(call(&db, request).unwrap()["version"], 2);
}

#[test]
fn recovery_replay_rejects_same_commit_advance_and_changed_pending_decision() {
    let db = repo();
    let request = blocked(&db, false);
    call(&db, request.clone()).unwrap();
    db.query(
        "UPDATE repository SET payload=json_set(payload,'$.version',3,'$.pending','decision:next')",
        &[],
    )
    .unwrap();
    assert_eq!(call(&db, request.clone()).unwrap_err().code, "HEAD_MOVED");
    db.query(
        "UPDATE repository SET payload=json_set(payload,'$.version',2)",
        &[],
    )
    .unwrap();
    assert_eq!(call(&db, request).unwrap_err().code, "HEAD_MOVED");
}

#[test]
fn capacity_backoff_is_bounded_and_never_extends_job_deadlines() {
    let db = repo();
    start(&db);
    let id = "job:run-one:research";
    let original = crate::storage::get(&db, "jobs", id).unwrap();
    let mut now = 1000;
    for backoff in [5000, 10000, 20000, 40000, 60000, 60000] {
        let claimed = call(&db, json!({"op":"claim","job_id":id,"now":now})).unwrap();
        let deferred = call(
            &db,
            json!({"op":"defer_job","job_id":id,"epoch":claimed["epoch"],
            "now":now,"reason":"container_capacity"}),
        )
        .unwrap();
        assert_eq!(deferred["not_before"], now + backoff);
        assert_eq!(deferred["deadline"], original["deadline"]);
        assert_eq!(deferred["dispatch_deadline"], original["dispatch_deadline"]);
        now += backoff;
    }
    assert_eq!(
        call(&db, json!({"op":"claim","job_id":id,"now":1201000}))
            .unwrap_err()
            .code,
        "ATTEMPTS_EXHAUSTED"
    );
}

#[test]
fn deferred_first_attempt_expires_at_dispatch_deadline_even_with_long_execution_budget() {
    let db = repo();
    start(&db);
    let id = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":id})).unwrap();
    call(
        &db,
        json!({"op":"defer_job","job_id":id,"epoch":1,"reason":"container_capacity"}),
    )
    .unwrap();
    // A long approved execution allowance outlives the separate dispatch window.
    db.query(
        "UPDATE jobs SET payload=json_set(payload,'$.deadline',3001000) WHERE id=?",
        &[json!(id)],
    )
    .unwrap();
    call(&db, json!({"op":"recover","now":1201000})).unwrap();
    assert_eq!(
        crate::storage::get(&db, "jobs", id).unwrap()["status"],
        "failed"
    );
}
