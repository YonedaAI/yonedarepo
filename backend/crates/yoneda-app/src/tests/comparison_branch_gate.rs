use super::*;

#[test]
fn legacy_compare_first_checked_builder_does_not_select_working_head() {
    let db = repo_with_policy(single_agent::policy());
    let initial = "a".repeat(40);
    call(
        &db,
        json!({"op":"create_working_branch","id":"development",
            "expected_commit":initial,"expected_version":0}),
    )
    .unwrap();
    let before = call(&db, json!({"op":"working_branch","id":"development"})).unwrap();
    let run = call(
        &db,
        json!({"op":"start_run","id":"legacy-compare",
        "intent":"Compare two implementations before choosing either",
        "mode":"compare","working_branch_id":"development",
        "expected_working_commit":initial,"expected_working_version":0,
        "agents":[
            {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"},
            {"provider":"zai","model":"glm-4.7-flash","strategy":"accessible"}
        ]}),
    )
    .unwrap();
    assert!(run.get("comparison").is_none_or(Value::is_null));
    assert_eq!(run["execution_count"], 2);

    // Trusted synthetic capture and clean evaluator observations use real ledger
    // transactions. Only the first builder finishes; there is no selection call.
    let candidate = single_agent::eligible(&db, "legacy-compare", 1, &"b".repeat(40));
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    let checked = snapshot["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|record| record["id"] == candidate)
        .unwrap();
    assert_eq!(checked["status"], "eligible");
    assert_eq!(checked["revision"]["commit"], "b".repeat(40));
    assert_eq!(snapshot["evaluations"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["repository"]["published_commit"], initial);
    assert!(snapshot["decisions"].as_array().unwrap().is_empty());
    let second = snapshot["executions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|execution| execution["id"] == "legacy-compare:agent-2")
        .unwrap();
    assert_eq!(second["status"], "queued");

    let branch = call(&db, json!({"op":"working_branch","id":"development"})).unwrap();
    assert_eq!(
        branch["version"], before["version"],
        "Completing one Compare evaluation must not implicitly select its candidate"
    );
    assert_eq!(branch["working_revision"], before["working_revision"]);
    assert_eq!(branch["latest_candidate_id"], before["latest_candidate_id"]);
}
