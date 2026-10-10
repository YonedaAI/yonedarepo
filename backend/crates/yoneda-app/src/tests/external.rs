use super::*;
fn begin() -> Value {
    json!({"op":"external_begin","id":"external-one","_grant":"grant-one","fork":"test/external-fork","intent":"Improve the website","context":[],"criteria":["Accessible navigation"]})
}
#[test]
fn external_attempts_derive_authorship_fence_submission_and_share_capture_pipeline() {
    let db = repo_with_policy(serde_json::to_value(yoneda_core::Policy::default()).unwrap());
    let attempt = call(&db, begin()).unwrap();
    assert_eq!(attempt["external_grant"], "grant-one");
    assert_eq!(attempt["workspace_transport"], "json-v1");
    assert_eq!(call(&db, begin()).unwrap(), attempt);
    let context = json!({"op":"context_publish","_grant":"grant-one","job_id":"job:external-one","epoch":1,"record":{"id":"context:external","kind":"finding","statement":"Navigation needs focus styles","purpose":"Guide the change","intent_id":"intent:run:external-one","author":"owner"}});
    let node = call(&db, context.clone()).unwrap();
    assert_eq!(node["author"], "external-one");
    let mut wrong = json!({"op":"external_check","attempt_id":"external-one","_grant":"other"});
    assert!(call(&db, wrong.clone()).is_err());
    wrong["_grant"] = json!("grant-one");
    assert!(call(&db, wrong).is_ok());
    call(
        &db,
        json!({"op":"external_freeze","attempt_id":"external-one","_grant":"grant-one"}),
    )
    .unwrap();
    let seq = call(&db, json!({"op":"snapshot"})).unwrap()["seq"].clone();
    call(
        &db,
        json!({"op":"external_freeze","attempt_id":"external-one","_grant":"grant-one"}),
    )
    .unwrap();
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap()["seq"], seq);
    assert!(call(&db, context).is_err());
    assert!(
        call(
            &db,
            json!({"op":"external_check","attempt_id":"external-one","_grant":"grant-one"})
        )
        .is_err()
    );
    let bind = json!({"op":"external_bind","attempt_id":"external-one","_grant":"grant-one","revision":{"repository":"test/external-fork","commit":"b".repeat(40)}});
    call(&db, bind.clone()).unwrap();
    assert!(
        call(&db, {
            let mut b = bind;
            b["revision"]["commit"] = json!("c".repeat(40));
            b
        })
        .is_err()
    );
    let submit = json!({"op":"external_submit","attempt_id":"external-one","_grant":"grant-one","workspace":"d".repeat(64)});
    call(&db, submit.clone()).unwrap();
    call(&db, submit).unwrap();
    let captured = call(&db, json!({"op":"claim","job_id":"capture:external-one"})).unwrap();
    assert_eq!(captured["payload"]["base"]["commit"], "a".repeat(40));
    assert_eq!(captured["payload"]["workspace"], "d".repeat(64));
}

#[test]
fn git_v1_submission_uses_only_the_worker_bound_revision_and_skips_workspace_object() {
    let db = repo_with_policy(serde_json::to_value(yoneda_core::Policy::default()).unwrap());
    let mut repository = crate::storage::get(&db, "repository", "repo").unwrap();
    repository["workspace_transport"] = json!("git-native-v1");
    crate::storage::save(&db, "repository", "repo", &repository).unwrap();

    let attempt = call(&db, begin()).unwrap();
    assert_eq!(attempt["workspace_transport"], "git-native-v1");
    assert_eq!(
        attempt["payload"]["run"]["workspace_transport"],
        "git-native-v1"
    );
    let mut changed_repository = crate::storage::get(&db, "repository", "repo").unwrap();
    changed_repository["workspace_transport"] = json!("json-v1");
    crate::storage::save(&db, "repository", "repo", &changed_repository).unwrap();
    assert_eq!(
        crate::storage::get(&db, "jobs", "job:external-one").unwrap()["workspace_transport"],
        "git-native-v1"
    );
    call(
        &db,
        json!({"op":"external_freeze","attempt_id":"external-one","_grant":"grant-one"}),
    )
    .unwrap();
    let revision = json!({"repository":"test/external-fork","commit":"b".repeat(40)});
    call(
        &db,
        json!({"op":"external_bind","attempt_id":"external-one","_grant":"grant-one","revision":revision}),
    )
    .unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"external_submit","attempt_id":"external-one","_grant":"wrong"}),
        )
        .unwrap_err()
        .code,
        "FORBIDDEN"
    );
    let submitted = call(
        &db,
        json!({"op":"external_submit","attempt_id":"external-one","_grant":"grant-one","workspace":"f".repeat(64),"fork_revision":{"repository":"attacker/other","commit":"c".repeat(40)},"git_verified":false}),
    )
    .unwrap();
    assert_eq!(submitted["status"], "completed");
    let completed = crate::storage::get(&db, "jobs", "job:external-one").unwrap();
    assert_eq!(completed["result"]["git_verified"], true);
    assert_eq!(completed["result"]["fork_revision"], revision);
    assert!(completed["result"].get("workspace").is_none());
    assert_eq!(completed["result"]["submitted_revision"], revision);
    assert_eq!(completed["submitted_revision"], revision);
    let capture = crate::storage::get(&db, "jobs", "capture:external-one").unwrap();
    assert_eq!(capture["payload"]["workspace_transport"], "git-native-v1");
    assert_eq!(capture["payload"]["source_revision"], revision);
    assert!(capture["payload"].get("workspace").is_none());
    assert_eq!(
        call(
            &db,
            json!({"op":"external_submit","attempt_id":"external-one","_grant":"grant-one","workspace":"e".repeat(64)}),
        )
        .unwrap(),
        submitted
    );
}
#[test]
fn expired_external_attempts_never_schedule_a_paid_harness() {
    let db = repo_with_policy(serde_json::to_value(yoneda_core::Policy::default()).unwrap());
    call(&db, begin()).unwrap();
    assert!(call(&db, json!({"op":"claim","job_id":"job:external-one"})).is_err());
    let mut recover = json!({"op":"recover","now":3601001});
    crate::execute(&db, recover.take()).unwrap();
    let pending = call(&db, json!({"op":"outbox"})).unwrap();
    assert!(
        pending["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .all(|j| j["kind"] != "agent")
    );
    assert!(
        call(
            &db,
            json!({"op":"external_freeze","attempt_id":"external-one","_grant":"grant-one"})
        )
        .is_err()
    );
}
