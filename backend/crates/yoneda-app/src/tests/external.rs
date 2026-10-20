use super::*;
fn begin() -> Value {
    json!({"op":"external_begin","id":"external-one","_grant":"grant-one","branch":"contributions/external-one","intent":"Improve the website","context":[],"criteria":["Accessible navigation"]})
}
const CANONICAL: &str = "yoneda-dev/retry";

#[test]
fn external_attempts_derive_authorship_fence_submission_and_share_capture_pipeline() {
    let db = repo_with_policy(serde_json::to_value(yoneda_agents_core::Policy::default()).unwrap());
    let attempt = call(&db, begin()).unwrap();
    assert_eq!(attempt["external_grant"], "grant-one");
    assert_eq!(attempt["workspace_transport"], "platform-branch-v1");
    assert_eq!(attempt["external_branch"], "contributions/external-one");
    assert_eq!(attempt["external_fork"], CANONICAL);
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
    // Only a commit in the project's own repository can be bound, and only once.
    let foreign = json!({"op":"external_bind","attempt_id":"external-one","_grant":"grant-one","revision":{"repository":"attacker/other","commit":"b".repeat(40)}});
    assert_eq!(call(&db, foreign).unwrap_err().code, "FENCED");
    let bind = json!({"op":"external_bind","attempt_id":"external-one","_grant":"grant-one","revision":{"repository":CANONICAL,"commit":"b".repeat(40)}});
    call(&db, bind.clone()).unwrap();
    assert!(
        call(&db, {
            let mut b = bind;
            b["revision"]["commit"] = json!("c".repeat(40));
            b
        })
        .is_err()
    );
    let submit = json!({"op":"external_submit","attempt_id":"external-one","_grant":"grant-one"});
    call(&db, submit.clone()).unwrap();
    call(&db, submit).unwrap();
    let captured = call(&db, json!({"op":"claim","job_id":"capture:external-one"})).unwrap();
    assert_eq!(captured["payload"]["base"]["commit"], "a".repeat(40));
    assert_eq!(captured["payload"]["capture_subtype"], "platform_commit");
    assert_eq!(
        captured["payload"]["contribution"],
        json!({"repository":CANONICAL,"commit":"b".repeat(40)})
    );
    assert!(captured["payload"].get("workspace").is_none());
}

#[test]
fn contribution_capture_must_rebuild_the_submission_on_its_frozen_base() {
    let db = repo_with_policy(serde_json::to_value(yoneda_agents_core::Policy::default()).unwrap());
    call(&db, begin()).unwrap();
    call(
        &db,
        json!({"op":"external_freeze","attempt_id":"external-one","_grant":"grant-one"}),
    )
    .unwrap();
    let revision = json!({"repository":CANONICAL,"commit":"b".repeat(40)});
    call(&db,json!({"op":"external_bind","attempt_id":"external-one","_grant":"grant-one","revision":revision})).unwrap();
    // Forged receipts in the submission are ignored: the bound revision is the only input.
    call(&db,json!({"op":"external_submit","attempt_id":"external-one","_grant":"grant-one","workspace":"f".repeat(64),"git_verified":true})).unwrap();
    let completed = crate::storage::get(&db, "jobs", "job:external-one").unwrap();
    assert!(completed["result"].get("git_verified").is_none());
    assert!(completed["result"].get("workspace").is_none());
    let capture = call(&db, json!({"op":"claim","job_id":"capture:external-one"})).unwrap();
    let finish = |revision: Value, parents: Value| {
        call(
            &db,
            json!({"op":"finish","job_id":"capture:external-one","epoch":capture["epoch"],
            "result":{"id":"external-candidate","revision":revision,"parents":parents,"tree":"d".repeat(40),
            "paths":["index.html"],"summary":"Contribution","diff_digest":"e".repeat(64)}}),
        )
    };
    let fresh = json!({"repository":CANONICAL,"commit":"c".repeat(40)});
    for (revision, parents) in [
        (
            json!({"repository":"attacker/other","commit":"c".repeat(40)}),
            json!(["a".repeat(40)]),
        ),
        (fresh.clone(), json!(["b".repeat(40)])),
        (fresh.clone(), json!(["a".repeat(40), "b".repeat(40)])),
    ] {
        assert_eq!(
            finish(revision, parents).unwrap_err().code,
            "INVALID_CAPTURE"
        );
    }
    finish(fresh.clone(), json!(["a".repeat(40)])).unwrap();
    let candidate = crate::storage::get(&db, "candidates", "external-candidate").unwrap();
    assert_eq!(candidate["revision"], fresh);
    let evaluator = crate::storage::get(&db, "jobs", "evaluate:external-candidate").unwrap();
    assert_eq!(evaluator["payload"]["workspace_transport"], "api-source-v1");
    assert!(evaluator["payload"]["source_integrity"].is_object());
}
#[test]
fn expired_external_attempts_never_schedule_a_paid_harness() {
    let db = repo_with_policy(serde_json::to_value(yoneda_agents_core::Policy::default()).unwrap());
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
