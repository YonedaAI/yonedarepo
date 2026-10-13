use super::*;
use crate::{execute, native::NativeStore};

fn budget(provider: &str, model: &str) -> Value {
    json!({"provider":provider,"model":model,"max_requests":144,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":50000000,"pricing":{"input_microusd_per_million":250000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"}})
}
fn fixture() -> NativeStore {
    fixture_effort(None)
}
fn fixture_effort(effort: Option<&str>) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(&db,json!({"op":"init","now":1,"id":"repo","name":"Adaptive","remote":{"namespace":"test","name":"repo"},"commit":"a".repeat(40),"policy":{"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/index.js"],"timeout_seconds":30}]}}})).unwrap();
    let mut command = json!({"op":"start_run","_workspace":"_admin","now":2,"id":"run","intent":"Implement source search with keyboard navigation","mode":"collaborate","agents":[{"connection":"seed","provider":"codex","model":"gpt-5.6-luna","role_hint":"frontend","strategy":"Team participant"}],"adaptive_team":{"version":1,"requested_agents":[{"connection":"seed","role":"frontend"}]},"_approved_model_pool":[{"connection":"seed","provider":"codex","model":"gpt-5.6-luna"},{"connection":"cheap","provider":"zai","model":"glm-5.3-flash"}],"model_budgets":[budget("codex","gpt-5.6-luna"),budget("zai","glm-5.3-flash")]});
    if let Some(effort) = effort {
        command["agents"][0]["reasoning_effort"] = json!(effort);
        command["adaptive_team"]["requested_agents"][0]["reasoning_effort"] = json!(effort);
        command["_approved_model_pool"][0]["reasoning_efforts"] = json!(["low", "high"]);
    }
    execute(&db, command).unwrap();
    execute(
        &db,
        json!({"op":"claim","job_id":"job:run:planner","now":3}),
    )
    .unwrap();
    db
}

#[test]
fn adaptive_reasoning_choice_reaches_planner_and_source_job_without_changing_approval() {
    let db = fixture_effort(Some("high"));
    let before = get(&db, "runs", "run").unwrap();
    assert_eq!(
        execute(&db, json!({"op":"repository_overview"})).unwrap()["capabilities"]["reasoning_effort"],
        1
    );
    assert_eq!(
        get(&db, "jobs", "job:run:planner").unwrap()["payload"]["execution"]["reasoning_effort"],
        "high"
    );
    let proposal = execute(&db, propose()).unwrap();
    assert_eq!(proposal["data"]["agents"][0]["reasoning_effort"], "high");
    execute(&db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    assert_eq!(run["autonomy_approval"], before["autonomy_approval"]);
    let job = get(&db, "jobs", "job:run:task:ui").unwrap();
    assert_eq!(job["payload"]["execution"]["reasoning_effort"], "high");
    assert_eq!(job["payload"]["execution"]["agent_index"], 0);
    assert!(
        get(&db, "jobs", "job:run:task:api").unwrap()["payload"]["execution"]["reasoning_effort"]
            .is_null()
    );
}
fn propose() -> Value {
    json!({"op":"team_plan_propose","job_id":"job:run:planner","epoch":1,"now":4,"agents":[{"connection":"seed","role":"frontend"},{"connection":"cheap","role":"backend"}],"plan":{"version":1,"contract":"search API","integrator_agent":0,"integration_paths":["src/"],"tasks":[{"id":"ui","title":"Search UI","instructions":"Implement keyboard navigation","agent":0,"depends_on":[],"write_paths":["src/ui.rs"]},{"id":"api","title":"Search API","instructions":"Implement API","agent":1,"depends_on":[],"write_paths":["src/api.rs"]}]}})
}
#[test]
fn adaptive_planner_selects_pool_roster_without_mutating_original_approval() {
    let db = fixture();
    let before = get(&db, "runs", "run").unwrap();
    assert_eq!(before["agents"].as_array().unwrap().len(), 1);
    assert_eq!(before["autonomy_policy"]["enabled"], true);
    let proposal = execute(&db, propose()).unwrap();
    assert_eq!(get(&db, "runs", "run").unwrap()["agents"], before["agents"]);
    execute(&db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    let run = get(&db, "runs", "run").unwrap();
    assert_eq!(run["agents"].as_array().unwrap().len(), 2);
    assert_eq!(run["agents"][1]["provider"], "zai");
    assert_eq!(run["agents"][0]["role_hint"], "frontend");
    assert_eq!(run["autonomy_approval"], before["autonomy_approval"]);
    assert_eq!(run["model_budgets"], before["model_budgets"]);
    assert_eq!(run["team_plan_proposal"], proposal["id"]);
    for task in ["ui", "api"] {
        assert_eq!(
            get(&db, "jobs", &format!("job:run:task:{task}")).unwrap()["status"],
            "queued"
        );
    }
    assert!(get(&db, "jobs", "job:run:task:integrate").is_err());
}
#[test]
fn adaptive_proposals_reject_unknown_connection_and_changed_explicit_role_atomically() {
    for (index, key, value) in [
        (1, "connection", json!("unapproved")),
        (0, "role", json!("backend")),
    ] {
        let db = fixture();
        let before = get(&db, "runs", "run").unwrap();
        let mut c = propose();
        c["agents"][index][key] = value;
        assert!(execute(&db, c).is_err());
        assert_eq!(get(&db, "runs", "run").unwrap(), before);
    }
}

#[test]
fn adaptive_planner_cannot_replace_the_job_frozen_pool_authority() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["approved_model_pool"][0]["version"] = json!(1);
    run["agents"][0]["version"] = json!(1);
    run["adaptive_seed_agents"] = run["agents"].clone();
    run["adaptive_team_digest"] = json!(
        yoneda_core::fingerprint(
            &json!({"pool":run["approved_model_pool"],"request":run["adaptive_team"]})
        )
        .unwrap()
    );
    run["autonomy_approval"]["approved_model_pool"] = run["approved_model_pool"].clone();
    run["autonomy_approval"]["adaptive_team_digest"] = run["adaptive_team_digest"].clone();
    save(&db, "runs", "run", &run).unwrap();
    assert!(execute(&db, propose()).is_err());
    assert_eq!(get(&db, "runs", "run").unwrap(), run);
}

#[test]
fn adaptive_roster_changes_are_bound_to_each_immutable_draft() {
    let db = fixture();
    let first = execute(&db, propose()).unwrap();
    let mut changed = propose();
    changed["agents"][1]["role"] = json!("testing");
    assert_eq!(
        execute(&db, changed.clone()).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
    changed["expected_proposal"] = first["id"].clone();
    let second = execute(&db, changed).unwrap();
    assert_ne!(first["id"], second["id"]);
    assert_eq!(execute(&db, propose()).unwrap(), first);
    assert_eq!(
        get(&db, "runs", "run").unwrap()["team_plan_proposal"],
        second["id"]
    );
    execute(&db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    assert_eq!(
        get(&db, "runs", "run").unwrap()["agents"][1]["role_hint"],
        "testing"
    );
}
#[test]
fn adaptive_planner_rejects_proposal_corruption_and_budget_configuration_changes() {
    let db = fixture();
    let proposal = execute(&db, propose()).unwrap();
    let before = get(&db, "runs", "run").unwrap();
    let mut corrupt = proposal.clone();
    corrupt["data"]["agents"][1]["model"] = json!("claude-opus-5-5");
    save(&db, "nodes", proposal["id"].as_str().unwrap(), &corrupt).unwrap();
    assert!(execute(&db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).is_err());
    assert_eq!(get(&db, "runs", "run").unwrap(), before);
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["model_budgets"][0]["max_requests"] = json!(999);
    save(&db, "runs", "run", &run).unwrap();
    assert!(execute(&db, propose()).is_err());
    assert_eq!(get(&db, "runs", "run").unwrap(), run);
}
#[test]
fn ordinary_adaptive_repair_preserves_pool_authority_and_actual_roster() {
    let db = fixture_effort(Some("high"));
    execute(&db, propose()).unwrap();
    execute(&db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    let mut run = get(&db, "runs", "run").unwrap();
    run["coordinator_execution_id"] = json!("coord");
    run["status"] = json!("coordinating");
    save(&db, "runs", "run", &run).unwrap();
    let e = json!({"id":"coord","run_id":"run","team_role":"coordinator","role":"coding","status":"running","provider":"codex","model":"gpt-5.6-luna","connection":"seed","harness":"codex","reasoning_effort":"high","agent_index":0,"budget":{"provider":"codex","model":"gpt-5.6-luna"}});
    create(&db, "executions", "coord", &e).unwrap();
    create(&db,"jobs","job:coord",&json!({"id":"job:coord","kind":"agent","status":"running","epoch":1,"lease_until":10000,"attempt_deadline":10000,"payload":{"execution":e,"run":run,"policy":run["policy"],"team_planning":true}})).unwrap();
    let receipt=execute(&db,json!({"op":"repair_team","job_id":"job:coord","epoch":1,"now":6,"run_id":"run","request_id":"repair-api","expected_commit":"a".repeat(40),"expected_version":0,"expected_plan_revision":1,"task_ids":["api"],"expected_task_revisions":{"api":1,"integrate":1},"task_definitions":[{"id":"api","title":"API","instructions":"Correct the approved search contract","agent":1,"depends_on":[],"write_paths":["src/api.rs"]}]})).unwrap();
    assert_eq!(receipt["repair_round"], 1);
    let after = get(&db, "runs", "run").unwrap();
    for field in [
        "autonomy_approval",
        "approved_model_pool",
        "adaptive_team",
        "agents",
        "model_budgets",
        "planned_roster_digest",
    ] {
        assert_eq!(after[field], run[field], "{field}");
    }
    let job = get(&db, "jobs", "job:run:task:api").unwrap();
    assert_eq!(
        job["payload"]["run"]["autonomy_approval"],
        run["autonomy_approval"]
    );
    assert_eq!(job["payload"]["execution"]["model"], "glm-5.3-flash");
    assert_eq!(after["agents"][0]["reasoning_effort"], "high");
}

#[test]
fn adaptive_reasoning_override_and_auto_upgrades_are_rejected_atomically() {
    for (effort, index) in [(Some("high"), 0), (None, 0), (None, 1)] {
        let db = fixture_effort(effort);
        let before = get(&db, "runs", "run").unwrap();
        let mut c = propose();
        c["agents"][index]["reasoning_effort"] =
            json!(if effort.is_some() { "low" } else { "high" });
        assert!(execute(&db, c).is_err());
        assert_eq!(get(&db, "runs", "run").unwrap(), before);
    }
}

#[test]
fn adaptive_reasoning_tampered_job_is_fenced_before_any_budget_reservation() {
    let db = fixture_effort(Some("high"));
    let before = get(&db, "runs", "run").unwrap();
    let mut job = get(&db, "jobs", "job:run:planner").unwrap();
    job["payload"]["execution"]["reasoning_effort"] = json!("max");
    save(&db, "jobs", "job:run:planner", &job).unwrap();
    assert_eq!(execute(&db,json!({"op":"reserve_request","job_id":"job:run:planner","epoch":1,"kind":"model","input_bytes":100,"output_tokens":256,"now":4})).unwrap_err().code,"FENCED");
    assert_eq!(get(&db, "runs", "run").unwrap(), before);
    assert_eq!(get(&db, "jobs", "job:run:planner").unwrap(), job);
}

#[test]
fn adaptive_reasoning_seed_and_draft_attestation_cannot_be_forged() {
    let db = fixture_effort(Some("high"));
    let proposal = execute(&db, propose()).unwrap();
    let before = get(&db, "runs", "run").unwrap();
    let mut corrupted = proposal.clone();
    corrupted["data"]["agents"][0]["reasoning_effort"] = json!("low");
    save(&db, "nodes", proposal["id"].as_str().unwrap(), &corrupted).unwrap();
    assert!(execute(&db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).is_err());
    assert_eq!(get(&db, "runs", "run").unwrap(), before);
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["agents"][0]["reasoning_effort"] = json!("high");
    run["adaptive_seed_agents"] = run["agents"].clone();
    save(&db, "runs", "run", &run).unwrap();
    assert!(execute(&db, propose()).is_err());
}

#[test]
fn adaptive_auto_seed_does_not_select_new_catalog_model_without_compatibility_approval() {
    let db = fixture();
    let mut c = json!({"op":"start_run","_workspace":"_admin","now":4,"id":"new","intent":"Implement approved source change","mode":"collaborate","agents":[{"connection":"new-profile","provider":"codex","model":"gpt-6-luna","role_hint":"auto","strategy":"Team participant"}],"adaptive_team":{"version":1,"requested_agents":[{"connection":null,"role":"auto"}]},"_approved_model_pool":[{"connection":"new-profile","provider":"codex","model":"gpt-6-luna"}],"model_budgets":[budget("codex","gpt-6-luna")]});
    assert_eq!(execute(&db, c.clone()).unwrap_err().code, "FORBIDDEN");
    assert!(get(&db, "runs", "new").is_err());
    c["adaptive_team"]["requested_agents"][0]["connection"] = json!("new-profile");
    execute(&db, c).unwrap();
}

#[test]
fn adaptive_reasoning_coordinator_inherits_approved_effort_after_specialists_are_exhausted() {
    let db = fixture_effort(Some("high"));
    execute(&db, propose()).unwrap();
    execute(&db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    for (offset, task) in ["ui", "api"].iter().enumerate() {
        let id = format!("job:run:task:{task}");
        execute(
            &db,
            json!({"op":"claim","job_id":id,"now":6+offset as i64*2}),
        )
        .unwrap();
        execute(&db,json!({"op":"fail","job_id":id,"epoch":1,"retryable":false,"error":"Synthetic specialist failure","now":7+offset as i64*2})).unwrap();
    }
    let run = get(&db, "runs", "run").unwrap();
    let id = run["coordinator_execution_id"].as_str().unwrap();
    let job = get(&db, "jobs", &format!("job:{id}")).unwrap();
    assert_eq!(job["payload"]["execution"]["reasoning_effort"], "high");
    assert_eq!(job["payload"]["execution"]["agent_index"], 0);
    assert_eq!(job["payload"]["team_planning"], true);
    assert_eq!(
        job["payload"]["run"]["autonomy_approval"],
        run["autonomy_approval"]
    );
    assert_eq!(run["team_repair_rounds"].as_i64().unwrap_or(0), 0);
}
#[test]
fn adaptive_request_limit_is_shared_across_all_pool_groups_without_reset() {
    let db = fixture();
    let mut run = get(&db, "runs", "run").unwrap();
    run["model_requests"] = json!(144);
    save(&db, "runs", "run", &run).unwrap();
    let job = get(&db, "jobs", "job:run:planner").unwrap();
    let error=execute(&db,json!({"op":"reserve_request","job_id":"job:run:planner","epoch":1,"kind":"model","input_bytes":100,"output_tokens":256,"now":4})).unwrap_err();
    assert_eq!(error.code, "RESOURCE_LIMIT");
    assert_eq!(get(&db, "runs", "run").unwrap(), run);
    assert_eq!(get(&db, "jobs", "job:run:planner").unwrap(), job);
}
