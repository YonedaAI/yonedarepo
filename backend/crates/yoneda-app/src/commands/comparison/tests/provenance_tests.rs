use super::*;
use fixtures as f;
#[test]
fn human_publication_records_the_exact_working_selection_with_its_reason() {
    let db = f::db();
    f::call(&db,json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    let mut input = f::input();
    input["working_branch_id"] = json!("development");
    input["expected_working_commit"] = json!("a".repeat(40));
    input["expected_working_version"] = json!(0);
    f::call(&db, input).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    f::call(&db,json!({"op":"select_comparison_candidate","run_id":"compare","request_id":"human-choice","candidate_id":"candidate-2","reason":"Owner chooses approach two for clearer maintainability","expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_version":"compare-v1","expected_working_commit":"a".repeat(40),"expected_working_version":0,"expected_selection_version":0})).unwrap();
    let receipt=f::call(&db,json!({"op":"accept","request_id":"human-publication","candidate":"candidate-2","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Human approves publishing the checked maintainable approach","alternatives":[]})).unwrap();
    let d = get(&db, "decisions", receipt["id"].as_str().unwrap()).unwrap();
    assert_eq!(d["comparison"]["selected_candidate_id"], "candidate-2");
    assert_eq!(d["comparison"]["selection_version"], 1);
    assert_eq!(d["comparison"]["working_branch_version"], 1);
    assert_eq!(d["comparison"]["selected_by"], "owner");
    assert_eq!(
        d["comparison"]["selection_reason"],
        "Owner chooses approach two for clearer maintainability"
    );
    assert_eq!(
        d["rationale"],
        "Human approves publishing the checked maintainable approach"
    );
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
}
