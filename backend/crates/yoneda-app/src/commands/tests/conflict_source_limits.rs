use super::*;
#[test]
fn api_resolver_scope_limit_rejects_before_jobs_executions_or_budget_changes() {
    let db = setup();
    let mut run = get(&db, "runs", "run").unwrap();
    run["workspace_transport"] = json!("api-source-v1");
    run["model_requests"] = json!(77);
    run["team_repair_rounds"] = json!(1);
    save(&db, "runs", "run", &run).unwrap();
    let mut execution = get(&db, "executions", "execution").unwrap();
    execution["harness"] = json!("claude");
    execution["provider"] = json!("mimo");
    execution["model"] = json!("mimo-v2.6-flash");
    execution["context"] = json!([]);
    execution["budget"] = json!({"provider":"mimo","model":"mimo-v2.6-flash"});
    save_execution(&db, &execution, 2).unwrap();
    run["agents"] =
        json!([{"provider":"mimo","model":"mimo-v2.6-flash","connection":"mimo","role":"coding"}]);
    run["model_budgets"] = json!([{"provider":"mimo","model":"mimo-v2.6-flash","max_requests":100,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null,"requests":77,"charged_microusd":999}]);
    save(&db, "runs", "run", &run).unwrap();
    let candidate = get(&db, "candidates", "candidate").unwrap();
    let record = json!({"id":"large-conflict","status":"unresolved","candidate":candidate,"candidate_revision":candidate["revision"]["commit"],"target_revision":{"repository":"test/conflict","commit":"b".repeat(40)},"head_commit":"b".repeat(40),"expected_version":1,"workspace_revision":{"repository":"test/merge","commit":"d".repeat(40)},"merge_workspace_commit":"d".repeat(40),"conflict_paths":(0..65).map(|i|format!("src/conflict-{i}.rs")).collect::<Vec<_>>()});
    save(&db, "conflicts", "large-conflict", &record).unwrap();
    let jobs = all(&db, "jobs").unwrap();
    let executions = all(&db, "executions").unwrap();
    let input = json!({"op":"resolve_conflict","request_id":"large-resolver","conflict_id":"large-conflict","expected_commit":"b".repeat(40),"expected_version":1,"owner_brief":"Resolve both sides"});
    assert_eq!(execute(&db, input).unwrap_err().code, "SOURCE_SCOPE_LIMIT");
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    assert_eq!(all(&db, "executions").unwrap(), executions);
    assert_eq!(get(&db, "runs", "run").unwrap(), run);
    assert_eq!(get(&db, "conflicts", "large-conflict").unwrap(), record);
}
