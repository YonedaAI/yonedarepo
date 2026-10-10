use super::*;
fn snapshot(db: &NativeStore) -> Value {
    call(db, json!({"op":"snapshot"})).unwrap()
}

#[test]
fn git_approval_freezes_transport_and_rejects_unverified_completion_atomically() {
    let db = NativeStore::memory().unwrap();
    let policy = json!({"version":"git-v1","suite":"commands-v1","environment":yoneda_core::build::ENVIRONMENT,
        "required_checks":["syntax"],"build":{"checks":[{"name":"syntax","argv":["node","-e","process.exit(0)"],"timeout_seconds":10}]}});
    call(&db,json!({"op":"init","id":"git-native","name":"Git transport","commit":"a".repeat(40),
        "remote":{"namespace":"test","name":"git-native"},"policy":policy,"workspace_transport":"git-native-v1"})).unwrap();
    let run = call(
        &db,
        json!({"op":"start_run","id":"git-run","intent":"Keep captured source immutable",
        "agents":[{"provider":"codex","model":"gpt-5.6-luna","strategy":"Single scoped agent"}]}),
    )
    .unwrap();
    assert_eq!(run["workspace_transport"], "git-native-v1");
    let coding = call(&db, json!({"op":"claim","job_id":"job:git-run:agent-1"})).unwrap();
    assert_eq!(coding["payload"]["workspace_transport"], "git-native-v1");
    let before = snapshot(&db);
    let mut completion = json!({"op":"finish","job_id":coding["id"],"epoch":coding["epoch"],
        "result":{"fork_revision":{"repository":"test/assigned-fork","commit":"b".repeat(40)},"workspace":"c".repeat(64)}});
    assert_eq!(
        call(&db, completion.clone()).unwrap_err().code,
        "INVALID_CAPTURE"
    );
    assert_eq!(snapshot(&db), before);
    completion["result"]["git_verified"] = json!(true);
    call(&db, completion).unwrap();
    let capture = call(
        &db,
        json!({"op":"claim","job_id":"capture:git-run:agent-1"}),
    )
    .unwrap();
    assert_eq!(capture["payload"]["workspace_transport"], "git-native-v1");
    assert_eq!(
        capture["payload"]["source_revision"]["commit"],
        "b".repeat(40)
    );
    assert!(capture["payload"].get("workspace").is_none());
    assert_eq!(capture["payload"]["base"], run["base"]);
    call(&db,json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],
        "result":{"id":"captured-git","revision":{"repository":"test/assigned-fork","commit":"d".repeat(40)},
            "tree":"e".repeat(40),"paths":["public/index.html"],"diff_digest":"f".repeat(64),"summary":"Fresh captured source"}})).unwrap();
    let evaluator = call(&db, json!({"op":"claim","job_id":"evaluate:captured-git"})).unwrap();
    assert_eq!(evaluator["payload"]["workspace_transport"], "git-native-v1");
    assert_eq!(
        evaluator["payload"]["candidate"]["revision"]["commit"],
        "d".repeat(40)
    );
    assert_ne!(
        evaluator["payload"]["candidate"]["revision"]["commit"],
        "b".repeat(40)
    );
}

#[test]
fn repaired_team_agent_keeps_frozen_git_transport_through_capture_receipt() {
    let db = NativeStore::memory().unwrap();
    let policy = json!({"version":"git-v1","suite":"commands-v1","environment":yoneda_core::build::ENVIRONMENT,
        "required_checks":["syntax"],"build":{"checks":[{"name":"syntax","argv":["node","-e","process.exit(0)"],"timeout_seconds":10}]}});
    call(
        &db,
        json!({"op":"init","id":"repair-git-native","name":"Git team repair",
        "commit":"a".repeat(40),"remote":{"namespace":"test","name":"repair-git-native"},
        "policy":policy,"workspace_transport":"git-native-v1"}),
    )
    .unwrap();
    call(&db,json!({"op":"start_run","id":"repair-git-run","intent":"Repair a Git-native team task",
        "mode":"collaborate","agents":[
            {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"worker"},
            {"provider":"zai","model":"glm-5.3-flash","strategy":"integrator"}],
        "team":{"version":1,"contract":"Feature exports a function","integrator_agent":1,
            "integration_paths":["src/"],"tasks":[{"id":"feature","title":"Feature",
                "instructions":"Implement the feature","agent":0,"depends_on":[],"write_paths":["src/feature.js"]}]}})).unwrap();

    let first = call(
        &db,
        json!({"op":"claim","job_id":"job:repair-git-run:task:feature"}),
    )
    .unwrap();
    assert_eq!(first["payload"]["workspace_transport"], "git-native-v1");
    call(
        &db,
        json!({"op":"fail","job_id":first["id"],"epoch":first["epoch"],
        "error":"Retry with the approved repair brief","retryable":false}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"repair_team","request_id":"repair-git-request",
        "expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-git-run",
        "expected_plan_revision":1,"task_ids":["feature"],"expected_task_revisions":{"feature":1},
        "owner_brief":"Fix the feature while preserving the Git fork workflow"}),
    )
    .unwrap();

    let repaired = call(
        &db,
        json!({"op":"claim","job_id":"job:repair-git-run:task:feature"}),
    )
    .unwrap();
    assert_eq!(repaired["payload"]["workspace_transport"], "git-native-v1");
    let receipt = json!({"repository":"test/repaired-agent-fork","commit":"b".repeat(40)});
    call(
        &db,
        json!({"op":"finish","job_id":repaired["id"],"epoch":repaired["epoch"],
        "result":{"git_verified":true,"fork_revision":receipt}}),
    )
    .unwrap();
    let capture = call(
        &db,
        json!({"op":"claim","job_id":"capture:repair-git-run:task:feature:r2"}),
    )
    .unwrap();
    assert_eq!(capture["payload"]["workspace_transport"], "git-native-v1");
    assert_eq!(capture["payload"]["source_revision"], receipt);
    assert!(capture["payload"].get("workspace").is_none());
}

#[test]
fn repaired_legacy_team_agent_keeps_json_workspace_contract() {
    let db = NativeStore::memory().unwrap();
    let policy = json!({"version":"legacy-v1","suite":"commands-v1","environment":yoneda_core::build::ENVIRONMENT,
        "required_checks":["syntax"],"build":{"checks":[{"name":"syntax","argv":["node","-e","process.exit(0)"],"timeout_seconds":10}]}});
    call(&db,json!({"op":"init","id":"repair-legacy","name":"Legacy team repair",
        "commit":"a".repeat(40),"remote":{"namespace":"test","name":"repair-legacy"},"policy":policy})).unwrap();
    call(&db,json!({"op":"start_run","id":"repair-legacy-run","intent":"Keep legacy repair transport",
        "mode":"collaborate","agents":[
            {"provider":"mimo","model":"mimo-v2.6-flash","strategy":"worker"},
            {"provider":"zai","model":"glm-5.3-flash","strategy":"integrator"}],
        "team":{"version":1,"contract":"Feature exports a function","integrator_agent":1,
            "integration_paths":["src/"],"tasks":[{"id":"feature","title":"Feature",
                "instructions":"Implement the feature","agent":0,"depends_on":[],"write_paths":["src/feature.js"]}]}})).unwrap();
    let first = call(
        &db,
        json!({"op":"claim","job_id":"job:repair-legacy-run:task:feature"}),
    )
    .unwrap();
    assert!(first["payload"].get("workspace_transport").is_none());
    call(
        &db,
        json!({"op":"fail","job_id":first["id"],"epoch":first["epoch"],
        "error":"Retry with the approved repair brief","retryable":false}),
    )
    .unwrap();
    call(
        &db,
        json!({"op":"repair_team","request_id":"repair-legacy-request",
        "expected_commit":"a".repeat(40),"expected_version":0,"run_id":"repair-legacy-run",
        "expected_plan_revision":1,"task_ids":["feature"],"expected_task_revisions":{"feature":1},
        "owner_brief":"Fix the feature"}),
    )
    .unwrap();
    let repaired = call(
        &db,
        json!({"op":"claim","job_id":"job:repair-legacy-run:task:feature"}),
    )
    .unwrap();
    assert!(repaired["payload"].get("workspace_transport").is_none());
    call(
        &db,
        json!({"op":"finish","job_id":repaired["id"],"epoch":repaired["epoch"],
        "result":{"workspace":"c".repeat(64)}}),
    )
    .unwrap();
    let capture = call(
        &db,
        json!({"op":"claim","job_id":"capture:repair-legacy-run:task:feature:r2"}),
    )
    .unwrap();
    assert!(capture["payload"].get("workspace_transport").is_none());
    assert_eq!(capture["payload"]["workspace"], "c".repeat(64));
}
