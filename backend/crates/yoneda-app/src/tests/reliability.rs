use super::*;

#[test]
fn refreshed_candidate_requires_its_reserved_repository_version() {
    let db = repo();
    let request = ready(&db);
    db.query("UPDATE candidates SET payload=json_set(payload,'$.refresh_expected_version',7) WHERE id='candidate-a'", &[]).unwrap();
    assert_eq!(call(&db, request).unwrap_err().code, "HEAD_MOVED");
}

#[test]
fn exhausted_evaluator_makes_the_candidate_terminal() {
    let db = repo();
    captured(&db);
    call(&db, json!({"op":"claim","job_id":"evaluate:candidate-a"})).unwrap();
    call(&db, json!({"op":"fail","job_id":"evaluate:candidate-a","epoch":1,"retryable":false,"error":"Evaluator exhausted"})).unwrap();
    let candidate = crate::storage::get(&db, "candidates", "candidate-a").unwrap();
    assert_eq!(candidate["status"], "failed");
}

#[test]
fn failed_external_evaluation_finishes_run_without_a_mode_field() {
    let db = repo();
    captured(&db);
    db.query("UPDATE runs SET payload=json_set(json_remove(payload,'$.mode'),'$.external',json('true')) WHERE id='run-one'", &[]).unwrap();
    db.query("UPDATE executions SET payload=json_set(payload,'$.status','cancelled') WHERE id<>'run-one:agent-1'",&[]).unwrap();
    call(&db, json!({"op":"claim","job_id":"evaluate:candidate-a"})).unwrap();
    call(&db,json!({"op":"fail","job_id":"evaluate:candidate-a","epoch":1,"retryable":false,"error":"Controlled external evaluator failure"})).unwrap();
    assert_eq!(
        crate::storage::get(&db, "runs", "run-one").unwrap()["status"],
        "failed"
    );
}

#[test]
fn all_failed_compare_agents_finish_the_run() {
    let db = repo_with_policy(super::single_agent::policy());
    call(&db,json!({"op":"start_run","id":"failures","intent":"Compare bounded approaches","agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"},{"provider":"zai","model":"glm-4.7-flash","strategy":"accessible"}]})).unwrap();
    for index in 1..=2 {
        let id = format!("job:failures:agent-{index}");
        call(&db, json!({"op":"claim","job_id":id})).unwrap();
        call(
            &db,
            json!({"op":"fail","job_id":id,"epoch":1,"retryable":false,"error":"Agent failed"}),
        )
        .unwrap();
    }
    assert_eq!(
        crate::storage::get(&db, "runs", "failures").unwrap()["status"],
        "failed"
    );
}

/// The platform readback observed `main` at another commit than the selected one.
fn blocked(db: &NativeStore) -> Value {
    let receipt = call(db, ready(db)).unwrap();
    call(db,json!({"op":"publication_readback","decision_id":receipt["id"],"observed_commit":"f".repeat(40)})).unwrap();
    json!({"op":"resync_repository","_workspace":"_admin","observed_commit":"f".repeat(40),"expected_version":1,"expected_pending":receipt["id"]})
}

#[test]
fn owner_resync_preserves_conflict_audit_and_clears_stale_site() {
    let db = repo();
    let request = blocked(&db);
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
        json!({"op":"start_run","id":"after-resync","intent":"Continue from observed remote","agents":one_agent()}),
    )
    .unwrap();
    db.query("UPDATE repository SET payload=json_set(payload,'$.version',3,'$.head_commit',?,'$.published_commit',?)", &[json!("d".repeat(40)),json!("d".repeat(40))]).unwrap();
    assert_eq!(call(&db, request).unwrap_err().code, "HEAD_MOVED");
}

#[test]
fn owner_resync_recognizes_a_later_landing_of_the_selected_commit() {
    let db = repo();
    let mut request = blocked(&db);
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
    let request = blocked(&db);
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
fn resync_without_pending_does_not_reblock() {
    let db = repo();
    blocked(&db);
    db.query(
        "UPDATE repository SET payload=json_set(payload,'$.pending',null)",
        &[],
    )
    .unwrap();
    let request = json!({"op":"resync_repository","_workspace":"_admin","expected_version":1,
        "expected_pending":null,"observed_commit":"a".repeat(40)});
    call(&db, request.clone()).unwrap();
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
    let request = blocked(&db);
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
