use super::*;
use fixtures as f;
#[test]
fn human_publication_links_immutable_review_and_exact_working_selection_with_distinct_reasons() {
    let db = f::db();
    f::call(&db,json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    let mut input = f::input();
    input["working_branch_id"] = json!("development");
    input["expected_working_commit"] = json!("a".repeat(40));
    input["expected_working_version"] = json!(0);
    f::call(&db, input).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    let j = run_jobs(&db, "compare")
        .unwrap()
        .into_iter()
        .find(|j| j["payload"]["comparison_review"] == true)
        .unwrap();
    f::call(&db, json!({"op":"claim","job_id":j["id"]})).unwrap();
    let context = f::call(
        &db,
        json!({"op":"comparison_context","job_id":j["id"],"epoch":1}),
    )
    .unwrap();
    let review=f::call(&db,json!({"op":"comparison_submit","job_id":j["id"],"epoch":1,"request_id":"why-review","manifest_digest":context["manifest_digest"],"outcome":"selected","candidate_id":"candidate-1","rationale":"Agent prefers approach one for its simpler transaction","alternatives":[{"candidate_id":"candidate-1","reason":"Simpler checked transaction"},{"candidate_id":"candidate-2","reason":"More complex checked transaction"}]})).unwrap();
    let original = get(&db, "nodes", review["review_id"].as_str().unwrap()).unwrap();
    f::call(&db,json!({"op":"finish","job_id":j["id"],"epoch":1,"result":{"review_only":true,"source_unchanged":true,"review_id":review["review_id"],"transcript":"e".repeat(64)}})).unwrap();
    f::call(&db,json!({"op":"select_comparison_candidate","run_id":"compare","request_id":"human-override","candidate_id":"candidate-2","reason":"Owner chooses approach two for clearer maintainability","expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_version":"compare-v1","expected_working_commit":"b".repeat(40),"expected_working_version":1,"expected_selection_version":1})).unwrap();
    let receipt=f::call(&db,json!({"op":"accept","request_id":"human-publication","candidate":"candidate-2","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Human approves publishing the checked maintainable approach","alternatives":[]})).unwrap();
    let d = get(&db, "decisions", receipt["id"].as_str().unwrap()).unwrap();
    assert_eq!(d["comparison"]["latest_review_id"], review["review_id"]);
    assert_eq!(d["comparison"]["selected_candidate_id"], "candidate-2");
    assert_eq!(d["comparison"]["selection_version"], 2);
    assert_eq!(d["comparison"]["working_branch_version"], 2);
    assert_eq!(d["comparison"]["selected_by"], "owner");
    assert_eq!(
        d["comparison"]["selection_reason"],
        "Owner chooses approach two for clearer maintainability"
    );
    assert_eq!(
        d["rationale"],
        "Human approves publishing the checked maintainable approach"
    );
    assert_eq!(
        get(&db, "nodes", review["review_id"].as_str().unwrap()).unwrap(),
        original
    );
    let graph = f::call(&db, json!({"op":"graph","id":d["id"],"depth":4})).unwrap();
    assert!(
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == review["review_id"])
    );
    assert!(
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["id"] == j["payload"]["execution"]["id"])
    );
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
}
