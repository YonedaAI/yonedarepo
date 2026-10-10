use super::*;
fn evaluating() -> NativeStore {
    let policy = json!({"version":"site-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["site"],"build":{"setup":[],"checks":[{"name":"site","argv":["node","-v"],"timeout_seconds":5}],"static_dir":"public"}});
    let db = repo_with_policy(policy);
    call(&db,json!({"op":"start_run","id":"site","intent":"A website","agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"a"},{"provider":"zai","model":"glm-4.7-flash","strategy":"b"}]})).unwrap();
    call(&db, json!({"op":"claim","job_id":"job:site:agent-1"})).unwrap();
    call(&db,json!({"op":"finish","job_id":"job:site:agent-1","epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap();
    call(&db, json!({"op":"claim","job_id":"capture:site:agent-1"})).unwrap();
    call(&db,json!({"op":"finish","job_id":"capture:site:agent-1","epoch":1,"result":{"id":"candidate-site","revision":{"repository":"test/fork","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/index.html"],"summary":"Website","diff":"html"}})).unwrap();
    call(
        &db,
        json!({"op":"claim","job_id":"evaluate:candidate-site"}),
    )
    .unwrap();
    db
}
fn verify(db: &NativeStore) {
    call(db,json!({"op":"verify_finish","job_id":"evaluate:candidate-site","epoch":1,"report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],"commands":[{"name":"site","output":{"exit":0}}]},"evidence":"e".repeat(64)})).unwrap();
}
#[test]
fn static_candidates_need_evaluator_manifest_and_publish_it_only_after_git_readback() {
    let db = evaluating();
    let files = json!({"index.html":{"content":"<html>site</html>"},"image.png":{"content":"/w==","encoding":"base64"}});
    let input = json!({"op":"register_site","job_id":"evaluate:candidate-site","epoch":1,"digest":"f".repeat(64),"files":files});
    let registered = call(&db, input.clone()).unwrap();
    assert_eq!(registered["commit"], "c".repeat(40));
    assert_eq!(call(&db, input.clone()).unwrap(), registered);
    let mut wrong = input.clone();
    wrong["epoch"] = json!(2);
    assert!(call(&db, wrong).is_err());
    let mut unsafe_files = input;
    unsafe_files["files"] = json!({"../escape":{"content":"bad"}});
    assert!(call(&db, unsafe_files).is_err());
    verify(&db);
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(
        snapshot["evaluations"][0]["deployment"]["digest"],
        "f".repeat(64)
    );
    assert!(snapshot["repository"]["site"].is_null());
    let decision=call(&db,json!({"op":"accept","request_id":"publish-site","candidate":"candidate-site","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Chosen for useful interactions","alternatives":[]})).unwrap();
    assert!(call(&db, json!({"op":"snapshot"})).unwrap()["repository"]["site"].is_null());
    let job = format!("publish:{}", decision["id"].as_str().unwrap());
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    call(
        &db,
        json!({"op":"finish","job_id":job,"epoch":1,"result":{"commit":"c".repeat(40)}}),
    )
    .unwrap();
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["repository"]["site"]["digest"], "f".repeat(64));
    assert_eq!(
        snapshot["repository"]["site"]["commit"],
        snapshot["repository"]["published_commit"]
    );
}
#[test]
fn missing_static_output_cannot_become_eligible() {
    let db = evaluating();
    verify(&db);
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["candidates"][0]["status"], "rejected");
}

#[test]
fn old_evaluations_without_assets_cannot_publish_and_conflicts_keep_the_previous_site() {
    let db = evaluating();
    verify(&db);
    // A preceding Worker version could mark a static candidate eligible without an asset manifest.
    db.query("UPDATE candidates SET payload=json_set(payload,'$.status','eligible') WHERE id='candidate-site'",&[]).unwrap();
    let accept = json!({"op":"accept","request_id":"old-site","candidate":"candidate-site","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Choose","alternatives":[]});
    assert_eq!(call(&db, accept).unwrap_err().code, "CHECKS_FAILED");
    let db = evaluating();
    call(&db,json!({"op":"register_site","job_id":"evaluate:candidate-site","epoch":1,"digest":"f".repeat(64),"files":{"index.html":{"content":"Site"}}})).unwrap();
    verify(&db);
    let old = json!({"digest":"0".repeat(64),"commit":"a".repeat(40)});
    db.query(
        "UPDATE repository SET payload=json_set(payload,'$.site',json(?))",
        &[json!(old.to_string())],
    )
    .unwrap();
    let d=call(&db,json!({"op":"accept","request_id":"conflict-site","candidate":"candidate-site","expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Choose","alternatives":[]})).unwrap();
    let job = format!("publish:{}", d["id"].as_str().unwrap());
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    call(&db,json!({"op":"finish","job_id":job,"epoch":1,"result":{"conflict":true,"observed":"b".repeat(40)}})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["repository"]["site"],
        old
    );
}

#[test]
fn owner_resync_restores_only_the_selected_evaluator_site_after_lost_acknowledgement() {
    let db = evaluating();
    let site = call(
        &db,
        json!({"op":"register_site","job_id":"evaluate:candidate-site","epoch":1,
        "digest":"f".repeat(64),"files":{"index.html":{"content":"Checked site"}}}),
    )
    .unwrap();
    verify(&db);
    let decision = call(
        &db,
        json!({"op":"accept","request_id":"recover-site","candidate":"candidate-site",
        "expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Choose checked site"}),
    )
    .unwrap();
    let job = format!("publish:{}", decision["id"].as_str().unwrap());
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    call(
        &db,
        json!({"op":"fail","job_id":job,"epoch":1,"retryable":false,"error":"Readback lost"}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"resync_repository","_workspace":"_admin","expected_version":1,
        "expected_pending":decision["id"],"observed_commit":"c".repeat(40)}),
    )
    .unwrap();
    let snapshot = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(snapshot["repository"]["site"], site);
    assert_eq!(
        snapshot["repository"]["site"]["commit"],
        snapshot["repository"]["published_commit"]
    );
    assert_eq!(snapshot["decisions"][0]["status"], "published");
    assert_eq!(snapshot["decisions"][0]["error"], "Readback lost");
}
