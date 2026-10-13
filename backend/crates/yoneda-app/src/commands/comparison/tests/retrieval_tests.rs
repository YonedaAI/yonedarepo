use super::*;
use fixtures as f;
#[test]
fn reviewer_context_is_manifest_scoped_and_cannot_publish_a_context_assertion() {
    let db = f::db();
    f::start(&db);
    f::call(&db,json!({"op":"context_publish","record":{"id":"finding:future-context","intent_id":"intent:compare","kind":"finding","statement":"Future unapproved booking instruction","purpose":"Unselected future context","links":[],"file_paths":[]}})).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    let reviewer = run_jobs(&db, "compare")
        .unwrap()
        .into_iter()
        .find(|j| j["payload"]["comparison_review"] == true)
        .unwrap();
    f::call(&db, json!({"op":"claim","job_id":reviewer["id"]})).unwrap();
    let request =
        json!({"op":"context_get","job_id":reviewer["id"],"epoch":1,"id":"finding:future-context"});
    assert_eq!(f::call(&db, request).unwrap_err().code, "FORBIDDEN");
    assert!(
        f::call(
            &db,
            json!({"op":"context_get","id":"finding:future-context"})
        )
        .is_ok()
    );
    let result = f::call(
        &db,
        json!({"op":"context_search","job_id":reviewer["id"],"epoch":1,"query":"Future"}),
    )
    .unwrap();
    assert_eq!(result["items"], json!([]));
    let publish = json!({"op":"context_publish","job_id":reviewer["id"],"epoch":1,"record":{"id":"finding:reviewer-mutation","intent_id":"intent:compare","kind":"finding","statement":"Reviewer tries to mutate unrelated graph","purpose":"Forbidden assertion","links":[],"file_paths":[]}});
    assert_eq!(f::call(&db, publish).unwrap_err().code, "FORBIDDEN");
    assert!(get(&db, "nodes", "finding:reviewer-mutation").is_err());
}
