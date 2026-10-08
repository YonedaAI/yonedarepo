use super::*;

fn product_policy() -> Value {
    json!({"version":"site-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}],"static_dir":"public"}})
}
fn run_command() -> Value {
    json!({"op":"start_run","id":"site","intent":"Build a portfolio website","criteria":["Works on a phone"],"agents":[{"provider":"mimo","model":"mimo-v2-flash","strategy":"minimal"},{"provider":"zai","model":"glm-4.7-flash","strategy":"accessible"}],"context":[]})
}
#[test]
fn failed_harness_retains_scoped_transcript_and_rejects_late_replacement() {
    let db = repo_with_policy(product_policy());
    call(&db, run_command()).unwrap();
    call(&db, json!({"op":"claim","job_id":"job:site:agent-1"})).unwrap();
    let record = json!({"op":"record_transcript","job_id":"job:site:agent-1","epoch":1,"digest":"e".repeat(64)});
    call(&db, record.clone()).unwrap();
    call(&db,json!({"op":"fail","job_id":"job:site:agent-1","epoch":1,"error":"Provider account has no balance","retryable":false})).unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    let e = s["executions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == "site:agent-1")
        .unwrap();
    assert_eq!(e["status"], "failed");
    assert_eq!(e["transcript"], "e".repeat(64));
    assert_eq!(call(&db, record).unwrap_err().code, "FENCED");
}
fn context(id: &str, kind: &str, statement: &str) -> Value {
    json!({"op":"context_publish","record":{"id":id,"kind":kind,"statement":statement,"purpose":"Explain the approach","intent_id":"intent:site","links":[]}})
}

#[test]
fn approved_brief_launches_concurrent_attempts_with_frozen_policy() {
    let db = repo_with_policy(product_policy());
    let run = call(&db, run_command()).unwrap();
    assert_eq!(run["status"], "exploring");
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    let attempts = s["executions"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert!(attempts.iter().all(|a| a["role"] == "coding"));
    assert_eq!(attempts[0]["base"], attempts[1]["base"]);
    let jobs = call(&db, json!({"op":"outbox"})).unwrap();
    assert_eq!(
        jobs["jobs"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|j| j["kind"] == "agent")
            .count(),
        2
    );
    let first = call(
        &db,
        json!({"op":"claim","job_id":format!("job:{}", attempts[0]["id"].as_str().unwrap())}),
    )
    .unwrap();
    assert_eq!(
        first["payload"]["policy"]["build"],
        product_policy()["build"]
    );
    assert_eq!(
        first["payload"]["run"]["criteria"],
        json!(["Works on a phone"])
    );
}

#[test]
fn context_is_typed_immutable_and_attributed_to_active_attempt() {
    let db = repo_with_policy(product_policy());
    call(&db, run_command()).unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    let eid = s["executions"][0]["id"].as_str().unwrap();
    let jid = format!("job:{eid}");
    call(&db, json!({"op":"claim","job_id":jid})).unwrap();
    let mut c = context(
        "assumption:mobile",
        "assumption",
        "Visitors may use screen readers",
    );
    c["job_id"] = json!(jid);
    c["epoch"] = json!(1);
    c["record"]["author"] = json!("owner");
    c["record"]["verified"] = json!(true);
    let record = call(&db, c.clone()).unwrap();
    assert_eq!(record["author"], eid);
    assert_eq!(record["data"]["authority"], "assertion");
    assert!(record["data"].get("verified").is_none());
    assert_eq!(record["kind"], "assumption");
    c["record"]["statement"] = json!("Changed claim");
    assert_eq!(call(&db, c).unwrap_err().code, "ALREADY_EXISTS");
    let mut next = context(
        "assumption:mobile:2",
        "finding",
        "Screen reader navigation passed a manual check",
    );
    next["record"]["links"] = json!([{"relation":"supersedes","target":"assumption:mobile"}]);
    call(&db, next).unwrap();
    let old = call(&db, json!({"op":"context_get","id":"assumption:mobile"})).unwrap();
    assert_eq!(old["label"], "Visitors may use screen readers");
}

#[test]
fn context_references_are_validated_and_search_has_stable_pages() {
    let db = repo_with_policy(product_policy());
    call(&db, run_command()).unwrap();
    let before = call(&db, json!({"op":"events","after":0})).unwrap();
    let mut bad = context("finding:bad", "finding", "Should roll back");
    bad["record"]["links"] = json!([{"relation":"supports","target":"missing"}]);
    assert!(call(&db, bad).is_err());
    assert_eq!(before, call(&db, json!({"op":"events","after":0})).unwrap());
    for kind in [
        "intent",
        "requirement",
        "constraint",
        "assumption",
        "finding",
        "alternative",
        "proposed_decision",
        "question",
    ] {
        call(
            &db,
            context(
                &format!("context:{kind}"),
                kind,
                &format!("Portfolio {kind}"),
            ),
        )
        .unwrap();
    }
    let page = call(
        &db,
        json!({"op":"context_search","query":"Portfolio","limit":3}),
    )
    .unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 3);
    let next = call(
        &db,
        json!({"op":"context_search","query":"Portfolio","limit":3,"cursor":page["next_cursor"]}),
    )
    .unwrap();
    assert_eq!(next["items"].as_array().unwrap().len(), 3);
    assert_ne!(page["items"][0]["id"], next["items"][0]["id"]);
    assert!(call(&db, json!({"op":"context_search","limit":501})).is_err());
    assert!(
        call(
            &db,
            context("context:fake", "verified", "Agents cannot certify work")
        )
        .is_err()
    );
}

#[test]
fn general_runs_reject_missing_checks_or_unbounded_attempts_atomically() {
    let db = repo_with_policy(product_policy());
    let mut c = run_command();
    c["agents"] = json!([{"provider":"mimo","model":"mimo-v2-flash","strategy":"only"}]);
    assert!(call(&db, c).is_err());
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["runs"],
        json!([])
    );
    let mut invalid = product_policy();
    invalid["build"]["checks"] = json!([]);
    assert!(call(&NativeStore::memory().unwrap(), json!({"op":"init","id":"invalid","name":"Bad","remote":{"namespace":"test","name":"test"},"commit":"a".repeat(40),"policy":invalid})).is_err());
}

#[test]
fn general_evaluator_uses_exit_observations_and_only_evaluator_can_submit_them() {
    let db = repo_with_policy(product_policy());
    call(&db, run_command()).unwrap();
    let agent = "job:site:agent-1";
    call(&db, json!({"op":"claim","job_id":agent})).unwrap();
    let report = json!({"suite":"commands-v1","environment":"linux-node24-rust1.94-v1","setup":[],"commands":[{"name":"build","status":"pass","output":{"exit":1}}]});
    assert_eq!(call(&db, json!({"op":"verify_finish","job_id":agent,"epoch":1,"report":report,"evidence":"e".repeat(64)})).unwrap_err().code, "FORBIDDEN");
    call(
        &db,
        json!({"op":"finish","job_id":agent,"epoch":1,"result":{"workspace":"b".repeat(64)}}),
    )
    .unwrap();
    call(&db, json!({"op":"claim","job_id":"capture:site:agent-1"})).unwrap();
    call(&db, json!({"op":"finish","job_id":"capture:site:agent-1","epoch":1,"result":{"id":"site-candidate","revision":{"repository":"yoneda-dev/site-fork","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/index.html"],"summary":"Accessible portfolio","diff":"html"}})).unwrap();
    call(
        &db,
        json!({"op":"claim","job_id":"evaluate:site-candidate"}),
    )
    .unwrap();
    call(&db, json!({"op":"verify_finish","job_id":"evaluate:site-candidate","epoch":1,"report":report,"evidence":"e".repeat(64)})).unwrap();
    let s = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(s["candidates"][0]["status"], "rejected");
    assert_eq!(s["evaluations"][0]["checks"][0]["status"], "fail");
}

#[test]
fn build_policy_updates_require_a_new_version_and_preserve_existing_run_policy() {
    let db = repo_with_policy(product_policy());
    call(&db, run_command()).unwrap();
    let mut policy = product_policy();
    policy["build"]["checks"][0]["argv"] = json!(["node", "--check", "changed.js"]);
    let mut update = json!({"op":"update_policy","expected_commit":"a".repeat(40),"expected_version":0,"expected_policy":"site-v1","policy":policy});
    assert!(call(&db, update.clone()).is_err());
    update["policy"]["version"] = json!("site-v2");
    call(&db, update).unwrap();
    let claim = call(&db, json!({"op":"claim","job_id":"job:site:agent-1"})).unwrap();
    assert_eq!(claim["payload"]["policy"]["version"], "site-v1");
    assert_eq!(claim["model"], "mimo-v2-flash");
    assert_eq!(
        claim["payload"]["policy"]["build"]["checks"][0]["argv"][2],
        "app.js"
    );
}

#[test]
fn repository_commands_enforce_the_trusted_workspace_scope() {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"init","id":"private","name":"Private","workspace":"alice","remote":{"namespace":"test","name":"private"},"commit":"a".repeat(40),"policy":product_policy()})).unwrap();
    assert_eq!(
        call(&db, json!({"op":"snapshot","_workspace":"bob"}))
            .unwrap_err()
            .code,
        "FORBIDDEN"
    );
    assert_eq!(
        call(&db, json!({"op":"snapshot","_workspace":"alice"})).unwrap()["repository"]["workspace"],
        "alice"
    );
    let mut run = run_command();
    run["_workspace"] = json!("bob");
    assert!(call(&db, run).is_err());
    assert_eq!(
        call(&db, json!({"op":"snapshot","_workspace":"alice"})).unwrap()["runs"],
        json!([])
    );
}

#[test]
fn attempt_request_limits_are_durable_fenced_and_capability_specific() {
    let db = repo_with_policy(product_policy());
    call(&db, run_command()).unwrap();
    let id = "job:site:agent-1";
    call(&db, json!({"op":"claim","job_id":id})).unwrap();
    for n in 1..=24 {
        let value = call(
            &db,
            json!({"op":"reserve_request","job_id":id,"epoch":1,"kind":"model"}),
        )
        .unwrap();
        assert_eq!(value["number"], n);
    }
    assert_eq!(
        call(
            &db.clone(),
            json!({"op":"reserve_request","job_id":id,"epoch":1,"kind":"model"})
        )
        .unwrap_err()
        .code,
        "RESOURCE_LIMIT"
    );
    assert!(
        call(
            &db,
            json!({"op":"reserve_request","job_id":id,"epoch":2,"kind":"dependency","bytes":1024})
        )
        .is_err()
    );
    call(&db,json!({"op":"reserve_request","job_id":id,"epoch":1,"kind":"dependency","bytes":16*1024*1024})).unwrap();
    assert!(call(&db,json!({"op":"reserve_request","job_id":id,"epoch":1,"kind":"dependency","bytes":129*1024*1024})).is_err());
}

#[test]
fn capture_after_policy_update_schedules_current_independent_verification() {
    let db = repo_with_policy(product_policy());
    call(&db, run_command()).unwrap();
    call(&db, json!({"op":"claim","job_id":"job:site:agent-1"})).unwrap();
    let mut next = product_policy();
    next["version"] = json!("site-v2");
    call(&db, json!({"op":"update_policy","expected_commit":"a".repeat(40),"expected_version":0,"expected_policy":"site-v1","policy":next})).unwrap();
    call(&db,json!({"op":"finish","job_id":"job:site:agent-1","epoch":1,"result":{"workspace":"b".repeat(64)}})).unwrap();
    call(&db, json!({"op":"claim","job_id":"capture:site:agent-1"})).unwrap();
    call(&db,json!({"op":"finish","job_id":"capture:site:agent-1","epoch":1,"result":{"id":"site-candidate","revision":{"repository":"test/fork","commit":"c".repeat(40)},"tree":"d".repeat(40),"paths":["public/index.html"],"summary":"Website","diff":"html"}})).unwrap();
    let evaluation = call(
        &db,
        json!({"op":"claim","job_id":"evaluate:site-candidate"}),
    )
    .unwrap();
    assert_eq!(evaluation["payload"]["policy"]["version"], "site-v2");
}
