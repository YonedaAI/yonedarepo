//! Publication lease, owner recovery and rejection over a multi-step checked working branch.
use super::*;

fn checked_step(db: &NativeStore, run: &str, candidate: &str, commit: &str) {
    let research = format!("job:{run}:research");
    call(db, json!({"op":"claim","job_id":research})).unwrap();
    call(db,json!({"op":"publish_artifact","job_id":research,"epoch":1,"id":format!("research-{run}"),"digest":"b".repeat(64),"label":"Constraints","kind":"research","metadata":{"assumptions":[{"statement":"Registration latency stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/booking.rs"}]}})).unwrap();
    call(
        db,
        json!({"op":"finish","job_id":research,"epoch":1,"result":{}}),
    )
    .unwrap();
    let coding = format!("job:{run}:codex-minimal");
    call(db, json!({"op":"claim","job_id":coding})).unwrap();
    call(
        db,
        json!({"op":"finish","job_id":coding,"epoch":1,"result":{"workspace":"b".repeat(64)}}),
    )
    .unwrap();
    let capture = format!("capture:{run}:codex-minimal");
    call(db, json!({"op":"claim","job_id":capture})).unwrap();
    call(db,json!({"op":"finish","job_id":capture,"epoch":1,"result":{"id":candidate,"revision":{"repository":"yoneda-dev/fork-a","commit":commit},"tree":"d".repeat(40),"paths":["src/booking.rs"],"summary":"Checked step"}})).unwrap();
    let evaluate = format!("evaluate:{candidate}");
    call(db, json!({"op":"claim","job_id":evaluate})).unwrap();
    let policy = crate::storage::repo(db).unwrap()["policy"].clone();
    call(db,json!({"op":"finish","job_id":evaluate,"epoch":1,"result":{"id":format!("evaluation-{candidate}"),"candidate":candidate,"revision":{"repository":"yoneda-dev/fork-a","commit":commit},"policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],"evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"compiled"},{"name":"behavior","status":"pass","detail":"verified"}]}})).unwrap();
}

/// Two checked steps: the publishable head's base is the intermediate commit `c`, not canonical `a`.
fn two_step_branch() -> NativeStore {
    let db = repo();
    call(&db, json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    call(&db,json!({"op":"start_run","id":"run-one","intent":"Implement registration","working_branch_id":"development","expected_working_commit":"a".repeat(40),"expected_working_version":0})).unwrap();
    checked_step(&db, "run-one", "candidate-a", &"c".repeat(40));
    call(&db,json!({"op":"start_run","id":"run-two","intent":"Add a waitlist","working_branch_id":"development","expected_working_commit":"c".repeat(40),"expected_working_version":1})).unwrap();
    checked_step(&db, "run-two", "candidate-b", &"f".repeat(40));
    assert_eq!(
        crate::storage::get(&db, "candidates", "candidate-b").unwrap()["base"]["commit"],
        "c".repeat(40)
    );
    db
}

fn accept(db: &NativeStore) -> Value {
    call(db,json!({"op":"accept","request_id":"publish-branch","candidate":"candidate-b","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Both checked steps pass","alternatives":[]})).unwrap()
}

#[test]
fn working_branch_publication_leases_the_canonical_head_not_the_candidate_base() {
    let db = two_step_branch();
    let decision = accept(&db);
    assert_eq!(decision["publication"]["expected"], "a".repeat(40));
    assert_eq!(decision["publication"]["commit"], "f".repeat(40));
    assert_eq!(decision["publication"]["ref"], "main");
    call(&db,json!({"op":"publication_readback","decision_id":decision["id"],"observed_commit":"f".repeat(40)})).unwrap();
    assert_eq!(
        crate::storage::repo(&db).unwrap()["published_commit"],
        "f".repeat(40)
    );
}

fn rejection(reason: &str) -> Value {
    json!({"op":"reject_candidate","request_id":"reject-1","candidate":"candidate-b","expected_commit":"a".repeat(40),"expected_version":0,"reason":reason})
}

#[test]
fn rejection_is_an_immutable_decision_that_leaves_canonical_untouched() {
    let db = two_step_branch();
    let before = crate::storage::repo(&db).unwrap();
    for reason in ["", "   ", &"x".repeat(2001)] {
        assert_eq!(
            call(&db, rejection(reason)).unwrap_err().code,
            "INVALID_INPUT"
        );
    }
    let receipt = call(&db, rejection("The waitlist hides cancelled bookings")).unwrap();
    assert_eq!(receipt["status"], "rejected");
    assert_eq!(
        call(&db, rejection("The waitlist hides cancelled bookings")).unwrap(),
        receipt
    );
    assert_eq!(
        call(&db, rejection("Different reason")).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
    let decision = call(&db, json!({"op":"decision","id":receipt["id"]})).unwrap();
    assert_eq!(decision["status"], "rejected");
    assert_eq!(decision["decision_kind"], "human");
    assert_eq!(decision["candidate"], "candidate-b");
    assert_eq!(decision["reason"], "The waitlist hides cancelled bookings");
    assert_eq!(decision["target"]["commit"], "f".repeat(40));
    let repository = crate::storage::repo(&db).unwrap();
    for key in [
        "head_commit",
        "published_commit",
        "version",
        "pending",
        "status",
    ] {
        assert_eq!(repository[key], before[key], "{key} changed");
    }
    let error = call(&db,json!({"op":"accept","request_id":"stale-tab","candidate":"candidate-b","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Stale tab"})).unwrap_err();
    assert_eq!(error.code, "CANDIDATE_REJECTED");
    let mut again = rejection("Second opinion");
    again["request_id"] = json!("reject-2");
    assert_eq!(call(&db, again).unwrap_err().code, "CANDIDATE_REJECTED");
}

#[test]
fn rejection_guards_stale_heads_agents_and_selected_candidates() {
    let db = two_step_branch();
    let mut stale = rejection("Stale");
    stale["expected_version"] = json!(3);
    assert_eq!(call(&db, stale).unwrap_err().code, "HEAD_MOVED");
    let mut agent = rejection("Agent cannot reject");
    agent["job_id"] = json!("job:run-two:research");
    agent["epoch"] = json!(1);
    assert_eq!(call(&db, agent).unwrap_err().code, "FORBIDDEN");
    accept(&db);
    let mut selected = rejection("Already selected");
    selected["expected_commit"] = json!("f".repeat(40));
    selected["expected_version"] = json!(1);
    assert_eq!(call(&db, selected).unwrap_err().code, "INVALID_STATE");
}

/// A result whose required checks failed can still be published, but only on the owner's
/// explicit override, which the decision records.
fn failed_result() -> NativeStore {
    let db = repo();
    call(&db,json!({"op":"start_run","id":"run-failed","intent":"Implement registration","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    checked_step(&db, "run-failed", "candidate-f", &"c".repeat(40));
    db.query(
        "UPDATE evaluations SET payload=json_set(payload,'$.checks[1].status','fail')",
        &[],
    )
    .unwrap();
    db.query("UPDATE candidates SET payload=json_set(payload,'$.status','rejected') WHERE id='candidate-f'", &[]).unwrap();
    db
}
fn publish(db: &NativeStore, override_checks: bool) -> Result<Value> {
    call(
        db,
        json!({"op":"accept","request_id":format!("publish-failed-{override_checks}"),"candidate":"candidate-f","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Owner reviewed the failing check","alternatives":[],"accept_failed_checks":override_checks}),
    )
}
#[test]
fn failed_checks_block_publication_without_an_explicit_owner_override() {
    let db = failed_result();
    assert_eq!(publish(&db, false).unwrap_err().code, "CHECKS_FAILED");
    let receipt = publish(&db, true).unwrap();
    assert_eq!(receipt["status"], "publication_pending");
    let decision = crate::storage::get(&db, "decisions", receipt["id"].as_str().unwrap()).unwrap();
    assert_eq!(decision["checks_overridden"], true);
}
