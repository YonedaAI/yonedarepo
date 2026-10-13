use super::*;
use fixtures as f;
fn legacy(limit: i64) -> crate::native::NativeStore {
    let db = f::db();
    let mut input = f::input();
    input.as_object_mut().unwrap().remove("comparison");
    input["delegation"] = json!({"enabled":true,"max_depth":1,"max_executions":limit});
    f::call(&db, input).unwrap();
    db
}
#[test]
fn exhausted_legacy_delegation_capacity_allows_supplemental_review_without_changing_approval() {
    let db = legacy(2);
    f::call(&db, json!({"op":"claim","job_id":"job:compare:agent-1"})).unwrap();
    f::call(&db,json!({"op":"reserve_request","job_id":"job:compare:agent-1","epoch":1,"kind":"model","input_bytes":10,"output_tokens":256})).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    let original = get(&db, "runs", "compare").unwrap();
    let approval = f::approval();
    let receipt = f::call(&db, approval.clone()).unwrap();
    let run = get(&db, "runs", "compare").unwrap();
    assert_eq!(run["delegation"], original["delegation"]);
    assert_eq!(run["model_budgets"], original["model_budgets"]);
    assert_eq!(run["model_requests"], original["model_requests"]);
    assert_eq!(run["execution_count"], 3);
    assert_eq!(f::call(&db, approval).unwrap(), receipt);
    let j = run_jobs(&db, "compare")
        .unwrap()
        .into_iter()
        .find(|j| j["payload"]["comparison_review"] == true)
        .unwrap();
    f::call(&db, json!({"op":"claim","job_id":j["id"]})).unwrap();
    assert_eq!(f::call(&db,json!({"op":"delegate_agent","job_id":j["id"],"epoch":1,"request_id":"review-child","task":"Unauthorized child","strategy":"child"})).unwrap_err().code,"FORBIDDEN");
    let ctx = f::call(
        &db,
        json!({"op":"comparison_context","job_id":j["id"],"epoch":1}),
    )
    .unwrap();
    let submission=f::call(&db,json!({"op":"comparison_submit","job_id":j["id"],"epoch":1,"request_id":"repair-review","manifest_digest":ctx["manifest_digest"],"outcome":"repair_requested","candidate_id":"candidate-1","rationale":"Tighten checked transaction behavior before choosing","alternatives":[{"candidate_id":"candidate-1","reason":"Promising transaction needs bounded repair"},{"candidate_id":"candidate-2","reason":"More complex alternative"}],"repair_instructions":"Tighten the existing booking transaction"})).unwrap();
    f::call(&db,json!({"op":"finish","job_id":j["id"],"epoch":1,"result":{"review_only":true,"source_unchanged":true,"review_id":submission["review_id"],"transcript":"e".repeat(64)}})).unwrap();
    let repair = run_jobs(&db, "compare")
        .unwrap()
        .into_iter()
        .find(|j| j["payload"]["execution"]["comparison_role"] == "repair")
        .unwrap();
    f::call(&db, json!({"op":"claim","job_id":repair["id"]})).unwrap();
    assert_eq!(f::call(&db,json!({"op":"delegate_agent","job_id":repair["id"],"epoch":1,"request_id":"repair-child","task":"Unauthorized new child","strategy":"child"})).unwrap_err().code,"FORBIDDEN");
}
#[test]
fn legacy_with_available_delegation_capacity_stays_manual_only_and_new_comparison_stays_strict() {
    let db = legacy(3);
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(f::call(&db, f::approval()).is_err());
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
    let db = f::db();
    let mut input = f::input();
    input["delegation"] = json!({"enabled":true,"max_depth":1,"max_executions":2});
    assert!(f::call(&db, input).is_err());
    assert!(get(&db, "runs", "compare").is_err());
}
