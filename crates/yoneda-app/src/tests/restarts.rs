use super::*;

fn configured() -> (NativeStore, Value) {
    let db = repo_with_policy(json!({"version":"build-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}));
    let c = json!({"op":"start_run","id":"original","intent":"Build a running club website",
        "agents":[{"provider":"mimo","model":"flash","strategy":"minimal"},
        {"provider":"zai","model":"flash","strategy":"accessible"}]});
    (db, c)
}

#[test]
fn restart_run_blocks_active_ancillary_jobs_including_legacy_publishers() {
    for kind in ["agent", "capture", "evaluate", "publish"] {
        let (db, original) = configured();
        call(&db, original.clone()).unwrap();
        if kind != "agent" {
            call(&db, json!({"op":"cancel_run","run_id":"original"})).unwrap();
            let payload = match kind {
                "capture" => json!({"execution":{"id":"original:agent-1","run_id":"original"}}),
                "evaluate" => {
                    json!({"candidate":{"execution":"original:agent-1","run_id":"original"}})
                }
                _ => {
                    crate::storage::create(
                        &db,
                        "decisions",
                        "old-decision",
                        &json!({"id":"old-decision","run_id":"original"}),
                    )
                    .unwrap();
                    json!({"decision_id":"old-decision"})
                }
            };
            crate::storage::job(&db, "ancillary", kind, 1000, payload).unwrap();
        }
        let before = call(&db, json!({"op":"snapshot"})).unwrap();
        let mut restart = original;
        restart["id"] = json!("restarted");
        restart["restart_of"] = json!("original");
        assert_eq!(call(&db, restart).unwrap_err().code, "RUN_ACTIVE", "{kind}");
        assert_eq!(
            call(&db, json!({"op":"snapshot"})).unwrap(),
            before,
            "{kind}"
        );
    }
}

#[test]
fn restart_run_preserves_old_records_and_uses_current_canonical_source_and_policy() {
    let (db, mut original) = configured();
    original["model_budgets"] = json!([
        {"provider":"mimo","model":"flash","max_requests":40,"max_output_tokens":512,"max_execution_ms":60000,"spend_limit_microusd":null,"pricing":null},
        {"provider":"zai","model":"flash","max_requests":40,"max_output_tokens":512,"max_execution_ms":60000,"spend_limit_microusd":null,"pricing":null}]);
    call(&db, original.clone()).unwrap();
    call(&db, json!({"op":"claim","job_id":"job:original:agent-1"})).unwrap();
    call(&db,json!({"op":"reserve_request","kind":"model","job_id":"job:original:agent-1","epoch":1,"input_bytes":10,"output_tokens":512})).unwrap();
    call(&db,json!({"op":"record_transcript","job_id":"job:original:agent-1","epoch":1,"digest":"e".repeat(64)})).unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"original"})).unwrap();
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    // Fixture represents an independently verified canonical publication after the old run.
    let mut canonical = crate::storage::repo(&db).unwrap();
    canonical["head_commit"] = json!("b".repeat(40));
    canonical["published_commit"] = json!("b".repeat(40));
    canonical["version"] = json!(1);
    canonical["policy"]["version"] = json!("build-v2");
    crate::storage::save(&db, "repository", "repo", &canonical).unwrap();
    let mut restart = original;
    restart["id"] = json!("restarted");
    restart["restart_of"] = json!("original");
    let fresh = call(&db, restart).unwrap();
    assert_eq!(fresh["restart_of"], "original");
    assert_eq!(fresh["base"]["commit"], "b".repeat(40));
    assert_eq!(fresh["policy"]["version"], "build-v2");
    assert_eq!(fresh["model_budgets"][0]["requests"], 0);
    assert_eq!(fresh["model_requests"], 0);
    let after = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(after["runs"][0], before["runs"][0]);
    let old: Vec<_> = after["executions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["run_id"] == "original")
        .cloned()
        .collect();
    assert_eq!(old, *before["executions"].as_array().unwrap());
    assert!(
        after["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["source"] == "original"
                && edge["target"] == "restarted"
                && edge["relation"] == "restarts")
    );
}
