use super::*;
use fixtures as f;
fn ready() -> crate::native::NativeStore {
    let db = f::db();
    f::call(&db,json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    let mut input = f::input();
    input.as_object_mut().unwrap().remove("comparison");
    input["working_branch_id"] = json!("development");
    input["expected_working_commit"] = json!("a".repeat(40));
    input["expected_working_version"] = json!(0);
    f::call(&db, input).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    db
}
fn select(id: &str, version: i64, head: &str, selection: i64) -> Value {
    json!({"op":"select_comparison_candidate","run_id":"compare","request_id":format!("select-{version}"),"candidate_id":id,"reason":"Prefer the smaller checked booking transaction","expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_version":"compare-v1","expected_working_commit":head,"expected_working_version":version,"expected_selection_version":selection})
}
#[test]
fn unchecked_choice_cannot_publish_legacy_working_branch_result() {
    let db = ready();
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    let error=f::call(&db,json!({"op":"accept","candidate":"candidate-1","request_id":"unselected","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Checks alone do not choose the comparison","alternatives":[]})).unwrap_err();
    assert_eq!(error.code, "COMPARISON_NOT_SELECTED");
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
}
#[test]
fn manual_legacy_selection_is_replay_safe_and_can_override_a_sibling_without_inference() {
    let db = ready();
    let request = select("candidate-1", 0, &"a".repeat(40), 0);
    let receipt = f::call(&db, request.clone()).unwrap();
    assert_eq!(f::call(&db, request).unwrap(), receipt);
    let replacement = select("candidate-2", 1, &"b".repeat(40), 1);
    f::call(&db, replacement).unwrap();
    let run = get(&db, "runs", "compare").unwrap();
    assert_eq!(run["comparison"]["selected_candidate_id"], "candidate-2");
    assert!(run["comparison"]["approval"].is_null());
    // Each sandbox agent is one attempt and one check job (no separate capture).
    assert_eq!(run_jobs(&db, "compare").unwrap().len(), 4);
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
    let stale = select("candidate-1", 1, &"b".repeat(40), 1);
    assert!(f::call(&db, stale).is_err());
}
#[test]
fn downstream_continuation_fences_manual_override_and_preserves_branch() {
    let db = ready();
    f::call(&db, select("candidate-1", 0, &"a".repeat(40), 0)).unwrap();
    let mut next = f::input();
    next["id"] = json!("next");
    next.as_object_mut().unwrap().remove("comparison");
    next["agents"] = json!([next["agents"][0]]);
    next["model_budgets"] = json!([next["model_budgets"][0]]);
    next["working_branch_id"] = json!("development");
    next["expected_working_commit"] = json!("b".repeat(40));
    next["expected_working_version"] = json!(1);
    f::call(&db, next).unwrap();
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(f::call(&db, select("candidate-2", 1, &"b".repeat(40), 1)).is_err());
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
}
#[test]
fn legacy_single_builder_working_choice_keeps_owner_selection_available() {
    let db = f::db();
    f::call(&db,json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    let mut input = f::input();
    input.as_object_mut().unwrap().remove("comparison");
    input["agents"] = json!([input["agents"][0]]);
    input["model_budgets"] = json!([input["model_budgets"][0]]);
    input["working_branch_id"] = json!("development");
    input["expected_working_commit"] = json!("a".repeat(40));
    input["expected_working_version"] = json!(0);
    f::call(&db, input).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    let choice = f::call(&db, select("candidate-1", 0, &"a".repeat(40), 0)).unwrap();
    assert_eq!(choice["comparison"]["selected_candidate_id"], "candidate-1");
    assert_eq!(run_jobs(&db, "compare").unwrap().len(), 2);
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
}
