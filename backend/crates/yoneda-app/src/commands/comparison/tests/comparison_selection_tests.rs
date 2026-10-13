use super::*;

fn choice() -> Value {
    json!({"op":"select_comparison_candidate","run_id":"compare","request_id":"owner-choice",
        "candidate_id":"candidate-2","reason":"Choose the checked defensive approach for its transaction boundary",
        "expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_version":"compare-v1",
        "expected_working_commit":"b".repeat(40),"expected_working_version":1,"expected_selection_version":1})
}

fn selected() -> (NativeStore, Value) {
    let (db, job, context) = ready();
    let receipt = f::call(&db, submit(&job, &context, "selected")).unwrap();
    complete(&db, &job, true).unwrap();
    (db, receipt)
}

#[test]
fn owner_override_is_reasoned_versioned_and_preserves_the_comparative_assertion() {
    let (db, review) = selected();
    let assertion = get(&db, "nodes", review["review_id"].as_str().unwrap()).unwrap();
    for (field, value) in [
        ("expected_commit", json!("f".repeat(40))),
        ("expected_version", json!(1)),
        ("expected_policy_version", json!("unknown-policy")),
        ("expected_working_commit", json!("a".repeat(40))),
        ("expected_working_version", json!(0)),
        ("expected_selection_version", json!(0)),
        ("reason", json!(" ")),
        ("job_id", json!("job:compare:agent-1")),
    ] {
        let mut forged = choice();
        forged[field] = value;
        let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
        assert!(f::call(&db, forged).is_err(), "{field}");
        assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
    }
    let receipt = f::call(&db, choice()).unwrap();
    assert_eq!(receipt["working_branch"]["version"], 2);
    assert_eq!(
        receipt["comparison"]["selected_candidate_id"],
        "candidate-2"
    );
    assert_eq!(receipt["comparison"]["selected_by"], "owner");
    assert_eq!(f::call(&db, choice()).unwrap(), receipt);
    assert_eq!(
        get(&db, "nodes", review["review_id"].as_str().unwrap()).unwrap(),
        assertion
    );
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
    assert!(
        !run_jobs(&db, "compare")
            .unwrap()
            .iter()
            .any(|j| j["kind"] == "publish")
    );
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(
        f::call(
            &db,
            json!({"op":"accept","request_id":"wrong-previous-selection",
        "candidate":"candidate-1","expected_commit":"a".repeat(40),"expected_version":0,
        "rationale":"Attempt to publish the superseded choice","alternatives":[]})
        )
        .is_err()
    );
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
}

#[test]
fn active_review_pending_publication_and_downstream_work_all_block_owner_override() {
    let (db, _, _) = ready();
    let mut active = choice();
    active["expected_working_commit"] = json!("a".repeat(40));
    active["expected_working_version"] = json!(0);
    active["expected_selection_version"] = json!(0);
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(f::call(&db, active).is_err());
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);

    let (db, _) = selected();
    f::call(
        &db,
        json!({"op":"accept","request_id":"explicit-human-publication",
        "candidate":"candidate-1","expected_commit":"a".repeat(40),"expected_version":0,
        "rationale":"Human approval is a separate publication decision","alternatives":[]}),
    )
    .unwrap();
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(
        f::call(&db, choice()).unwrap_err().code,
        "PUBLICATION_PENDING"
    );
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);

    let (db, _) = selected();
    f::call(&db, json!({"op":"start_run","id":"followup","intent":"Continue from the selected checked choice",
        "agents":[{"provider":"zai","model":"glm-5.3-flash","strategy":"continuation"}],
        "working_branch_id":"development","expected_working_commit":"b".repeat(40),"expected_working_version":1})).unwrap();
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(
        f::call(&db, choice()).unwrap_err().code,
        "WORKING_HEAD_MOVED"
    );
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
}

#[test]
fn changed_policy_fences_a_pending_proposal_and_does_not_reinterpret_its_checks() {
    let (db, job, context) = ready();
    let receipt = f::call(&db, submit(&job, &context, "selected")).unwrap();
    let original = get(&db, "nodes", receipt["review_id"].as_str().unwrap()).unwrap();
    let mut policy = repo(&db).unwrap()["policy"].clone();
    policy["version"] = json!("compare-v2");
    f::call(
        &db,
        json!({"op":"update_policy","policy":policy,"expected_commit":"a".repeat(40),
        "expected_version":0,"expected_policy":"compare-v1"}),
    )
    .unwrap();
    // Trusted completion cannot select old-policy evidence, even if new checks
    // have already been scheduled by the independently versioned policy change.
    let _ = complete(&db, &job, true);
    assert_eq!(
        get(&db, "working_branches", "development").unwrap()["version"],
        0
    );
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
    assert_eq!(
        get(&db, "nodes", receipt["review_id"].as_str().unwrap()).unwrap(),
        original
    );
}
