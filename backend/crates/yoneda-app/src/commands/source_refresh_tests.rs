use super::*;
use crate::commands::recovery::source_tests as f;
#[test]
fn sparse_refresh_paths_page_all_long_paths_and_recheck_target_lease() {
    let db = f::fixture();
    let mut r = repo(&db).unwrap();
    r["head_commit"] = json!("c".repeat(40));
    r["version"] = json!(1);
    save(&db, "repository", "repo", &r).unwrap();
    let paths = json!(
        (0..10000)
            .map(|i| format!("{i:04}/{}/{}", "x".repeat(240), "y".repeat(240)))
            .collect::<Vec<_>>()
    );
    let reference = crate::path_lists::persist(&db, &paths).unwrap();
    let candidate = json!({"id":"candidate","run_id":"run","execution":"execution","base":{"repository":"test/source","commit":"a".repeat(40)},"revision":{"repository":"test/candidate","commit":"f".repeat(40)},"tree":"e".repeat(40),"paths_ref":reference,"status":"eligible","evaluation":"evaluation"});
    save(&db, "candidates", "candidate", &candidate).unwrap();
    let mut run = get(&db, "runs", "run").unwrap();
    run["mode"] = json!("compare");
    save(&db, "runs", "run", &run).unwrap();
    let receipt=f::call(&db,json!({"op":"refresh_candidate","request_id":"request","candidate_id":"candidate","expected_commit":"c".repeat(40),"expected_version":1}),1000).unwrap();
    assert_eq!(receipt["job_id"], "capture:refresh:request");
    let queued = get(&db, "jobs", "capture:refresh:request").unwrap();
    assert_eq!(queued["payload"]["workspace_transport"], "api-source-v1");
    assert!(queued.to_string().len() < 1024 * 1024);
    assert!(queued["payload"].get("declared_paths").is_none());
    f::call(
        &db,
        json!({"op":"claim","job_id":"capture:refresh:request"}),
        1000,
    )
    .unwrap();
    let header = f::call(
        &db,
        json!({"op":"source_refresh_context","job_id":"capture:refresh:request","epoch":1}),
        1000,
    )
    .unwrap();
    assert!(header.to_string().len() < 2048);
    assert!(header.get("declared_paths").is_none());
    let request = json!({"op":"source_refresh_paths","job_id":"capture:refresh:request","epoch":1,"limit":200,"expected_digest":reference["digest"]});
    let mut member = request.clone();
    member["path"] = paths[0].clone();
    let allowed = f::call(&db, member.clone(), 1000).unwrap();
    assert_eq!(allowed["allowed"], true);
    assert!(allowed.get("items").is_none());
    member["path"] = json!("elsewhere.rs");
    assert_eq!(f::call(&db, member, 1000).unwrap()["allowed"], false);
    let mut query = request.clone();
    let mut count = 0;
    loop {
        let page = f::call(&db, query.clone(), 1000).unwrap();
        count += page["items"].as_array().unwrap().len();
        assert!(page.to_string().len() < 110000);
        if !page["has_more"].as_bool().unwrap() {
            break;
        }
        query["after"] = page["next_cursor"].clone();
    }
    assert_eq!(count, 10000);
    let mut wrong = request.clone();
    wrong["expected_digest"] = json!("0".repeat(64));
    assert_eq!(
        f::call(&db, wrong, 1000).unwrap_err().code,
        "VERSION_CONFLICT"
    );
    r["version"] = json!(2);
    save(&db, "repository", "repo", &r).unwrap();
    assert_eq!(f::call(&db, request, 1000).unwrap_err().code, "HEAD_MOVED");
}
