use super::*;

pub(super) fn policy() -> Value {
    json!({"version":"single-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}],"static_dir":"public"}})
}
fn agents() -> Value {
    json!([{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"minimal"},
        {"provider":"zai","model":"glm-4.7-flash","strategy":"accessible"}])
}
// Synthetic capture/evaluator observations verify ledger transitions without inference or Git.
pub(super) fn eligible(db: &NativeStore, run: &str, index: usize, commit: &str) -> String {
    let execution = format!("{run}:agent-{index}");
    let agent = format!("job:{execution}");
    call(db, json!({"op":"claim","job_id":agent})).unwrap();
    call(
        db,
        json!({"op":"finish","job_id":agent,"epoch":1,"result":{"workspace":"e".repeat(64)}}),
    )
    .unwrap();
    let capture = format!("capture:{execution}");
    call(db, json!({"op":"claim","job_id":capture})).unwrap();
    let candidate = format!("candidate-{run}-{index}");
    call(db, json!({"op":"finish","job_id":capture,"epoch":1,"result":{
        "id":candidate,"revision":{"repository":"yoneda-dev/fixture-fork","commit":commit},
        "tree":"f".repeat(40),"paths":["public/index.html"],"diff":"fixture diff","summary":"Website fixture"}})).unwrap();
    let evaluator = format!("evaluate:{candidate}");
    call(db, json!({"op":"claim","job_id":evaluator})).unwrap();
    call(db, json!({"op":"register_site","job_id":evaluator,"epoch":1,
        "digest":"e".repeat(64),"files":{"index.html":{"content":"<!doctype html><title>Fixture</title>"}}})).unwrap();
    call(db, json!({"op":"verify_finish","job_id":evaluator,"epoch":1,
        "report":{"suite":"commands-v1","environment":"linux-node24-rust1.94-v1",
            "setup":[],"commands":[{"name":"build","output":{"exit":0}}]},"evidence":"e".repeat(64)})).unwrap();
    candidate
}
pub(super) fn publish(db: &NativeStore, candidate: &str, request: &str, commit: &str) {
    let repository = call(db, json!({"op":"snapshot"})).unwrap()["repository"].clone();
    let receipt = call(
        db,
        json!({"op":"accept","request_id":request,"candidate":candidate,
        "expected_commit":repository["head_commit"],"expected_version":repository["version"],
        "rationale":"Owner selected the independently checked website","alternatives":[]}),
    )
    .unwrap();
    let job = format!("publish:{}", receipt["id"].as_str().unwrap());
    call(db, json!({"op":"claim","job_id":job})).unwrap();
    call(
        db,
        json!({"op":"finish","job_id":job,"epoch":1,"result":{"commit":commit}}),
    )
    .unwrap();
}

#[test]
fn single_agent_update_uses_published_source_and_preserves_two_agent_history() {
    let db = repo_with_policy(policy());
    call(
        &db,
        json!({"op":"start_run","id":"initial","intent":"Build a website","agents":agents()}),
    )
    .unwrap();
    let selected = eligible(&db, "initial", 1, &"b".repeat(40));
    eligible(&db, "initial", 2, &"c".repeat(40));
    publish(&db, &selected, "initial-choice", &"b".repeat(40));
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    let remaining = json!([agents()[1]]);
    let update = call(
        &db,
        json!({"op":"start_run","id":"update","intent":"Improve the website",
        "agents":remaining,"context":["intent:initial"]}),
    )
    .unwrap();
    assert_eq!(update["base"]["commit"], "b".repeat(40));
    assert_eq!(update["base_version"], 1);
    assert_eq!(update["execution_count"], 1);
    assert_eq!(
        update["delegation"],
        json!({"enabled":false,"max_depth":0,"max_executions":1})
    );
    assert_eq!(update["model_budgets"].as_array().unwrap().len(), 1);
    assert_eq!(update["model_budgets"][0]["provider"], "zai");
    assert_eq!(update["context_records"][0]["id"], "intent:initial");
    let candidate = eligible(&db, "update", 1, &"d".repeat(40));
    publish(&db, &candidate, "update-choice", &"d".repeat(40));
    let after = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(after["repository"]["published_commit"], "d".repeat(40));
    assert_eq!(after["repository"]["site"]["commit"], "d".repeat(40));
    assert_eq!(after["capabilities"]["agent_limits"]["min_root_agents"], 1);
    for table in [
        "runs",
        "executions",
        "candidates",
        "evaluations",
        "decisions",
    ] {
        for historical in before[table].as_array().unwrap() {
            assert!(
                after[table].as_array().unwrap().contains(historical),
                "Changed {table} history"
            );
        }
    }
    assert_eq!(after["executions"].as_array().unwrap().len(), 3);
}

#[test]
fn first_run_accepts_one_agent_and_rejects_zero_atomically() {
    let db = repo_with_policy(policy());
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"start_run","id":"empty","intent":"No worker","agents":[]})
        )
        .unwrap_err()
        .code,
        "INVALID_INPUT"
    );
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
    call(
        &db,
        json!({"op":"start_run","id":"single","intent":"Build alone","agents":[agents()[0]]}),
    )
    .unwrap();
    let after = call(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(after["executions"].as_array().unwrap().len(), 1);
    assert_eq!(after["runs"][0]["execution_count"], 1);
}
