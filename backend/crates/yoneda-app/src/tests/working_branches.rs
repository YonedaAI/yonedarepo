use super::*;

fn branch(db: &NativeStore) -> Value {
    call(db, json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap()
}

#[test]
fn checked_branch_can_continue_without_canonical_publication() {
    let db = repo();
    branch(&db);
    let run = call(&db,json!({"op":"start_run","id":"run-one","intent":"Implement registration","working_branch_id":"development","expected_working_commit":"a".repeat(40),"expected_working_version":0})).unwrap();
    assert_eq!(run["working_branch_id"], "development");
    let research = "job:run-one:research";
    call(&db, json!({"op":"claim","job_id":research})).unwrap();
    call(&db,json!({"op":"publish_artifact","job_id":research,"epoch":1,"id":"research-branch","digest":"b".repeat(64),"label":"Registration constraints","kind":"research","metadata":{"assumptions":[{"statement":"Registration latency stays within 100 ms","metric":"upstream_p99_ms","limit":100,"path":"src/booking.rs"}]}})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":research,"epoch":1,"result":{}}),
    )
    .unwrap();
    let coding = "job:run-one:codex-minimal";
    call(&db, json!({"op":"claim","job_id":coding})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":coding,"epoch":1,"result":{"workspace":"b".repeat(64)}}),
    )
    .unwrap();
    let capture = "capture:run-one:codex-minimal";
    call(&db, json!({"op":"claim","job_id":capture})).unwrap();
    call(&db,json!({"op":"finish","job_id":capture,"epoch":1,"result":{"id":"candidate-a","revision":{"repository":"yoneda-dev/fork-a","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["src/booking.rs"],"summary":"Registration implemented"}})).unwrap();
    call(&db, json!({"op":"claim","job_id":"evaluate:candidate-a"})).unwrap();
    let policy = crate::storage::repo(&db).unwrap()["policy"].clone();
    call(&db,json!({"op":"finish","job_id":"evaluate:candidate-a","epoch":1,"result":{"id":"evaluation-a","candidate":"candidate-a","revision":{"repository":"yoneda-dev/fork-a","commit":"c".repeat(40)},"policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],"evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"compiled"},{"name":"behavior","status":"pass","detail":"verified"}]}})).unwrap();
    let branch = call(&db, json!({"op":"working_branch","id":"development"})).unwrap();
    assert_eq!(branch["working_commit"], "c".repeat(40));
    assert_eq!(
        branch["working_revision"]["repository"],
        "yoneda-dev/fork-a"
    );
    assert_eq!(
        crate::storage::repo(&db).unwrap()["published_commit"],
        "a".repeat(40)
    );
    let update = call(&db,json!({"op":"start_run","id":"feature","intent":"Add a waitlist","working_branch_id":"development","expected_working_commit":"c".repeat(40),"expected_working_version":1})).unwrap();
    assert_eq!(update["base"]["commit"], "c".repeat(40));
    assert_eq!(update["base"]["repository"], "yoneda-dev/fork-a");
    assert!(
        update["context_records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == "intent:run-one")
    );
    let decision = call(&db,json!({"op":"accept","request_id":"publish-branch","candidate":"candidate-a","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Registration behavior is independently checked","alternatives":[]})).unwrap();
    let publish = format!("publish:{}", decision["id"].as_str().unwrap());
    call(&db, json!({"op":"claim","job_id":publish})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":publish,"epoch":1,"result":{"commit":"c".repeat(40)}}),
    )
    .unwrap();
    let published = crate::storage::repo(&db).unwrap();
    let branch = call(&db, json!({"op":"working_branch","id":"development"})).unwrap();
    assert_eq!(
        branch["canonical_base_commit"],
        published["published_commit"]
    );
    assert_eq!(branch["canonical_base_version"], published["version"]);
}

#[test]
fn superseded_resolver_evaluation_is_retained_but_cannot_advance_working_head() {
    use crate::storage::{create, get, save};
    let db = repo();
    branch(&db);
    let run = json!({"id":"run","status":"exploring","base":{"repository":"yoneda-dev/retry","commit":"a".repeat(40)},"working_branch_id":"development","working_branch_version":0,"team_plan_revision":2});
    save(&db, "runs", "run", &run).unwrap();
    let execution =
        json!({"id":"resolver","run_id":"run","status":"evaluating","resolver_plan_revision":1});
    save(&db, "executions", "resolver", &execution).unwrap();
    let candidate = json!({"id":"candidate","execution":"resolver","run_id":"run","status":"evaluating","base":run["base"],"revision":{"repository":"yoneda-dev/fork","commit":"b".repeat(40)},"paths":["src/registration.js"]});
    save(&db, "candidates", "candidate", &candidate).unwrap();
    let policy = crate::storage::repo(&db).unwrap()["policy"].clone();
    create(&db,"jobs","evaluate:candidate",&json!({"id":"evaluate:candidate","kind":"evaluate","status":"running","epoch":1,"lease_until":2000,"attempt_deadline":2000,"payload":{"candidate":candidate,"policy":policy}})).unwrap();
    call(&db,json!({"op":"finish","job_id":"evaluate:candidate","epoch":1,"result":{"id":"evaluation","candidate":"candidate","revision":candidate["revision"],"policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],"evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"compiled"},{"name":"behavior","status":"pass","detail":"verified"}]}})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"working_branch","id":"development"})).unwrap()["working_commit"],
        "a".repeat(40)
    );
    assert_eq!(
        get(&db, "candidates", "candidate").unwrap()["working_branch_state"],
        "stale"
    );
    assert!(get(&db, "evaluations", "evaluation").is_ok());
}

#[test]
fn stale_branch_start_does_not_create_run_or_dispatch() {
    let db = repo();
    branch(&db);
    let before = call(&db, json!({"op":"events"})).unwrap();
    let error = call(&db,json!({"op":"start_run","id":"stale","intent":"Update","working_branch_id":"development","expected_working_commit":"b".repeat(40),"expected_working_version":0})).unwrap_err();
    assert_eq!(error.code, "WORKING_HEAD_MOVED");
    assert!(crate::storage::get(&db, "runs", "stale").is_err());
    assert_eq!(before, call(&db, json!({"op":"events"})).unwrap());
}

#[test]
fn agent_cannot_create_an_owner_working_branch() {
    let db = repo();
    assert_eq!(call(&db,json!({"op":"create_working_branch","id":"forged","expected_commit":"a".repeat(40),"expected_version":0,"job_id":"invented","epoch":1})).unwrap_err().code,"FORBIDDEN");
}
