//! Owner-approved specialist connection: task-owning slots move to it, coordination stays.
use super::*;
use crate::{execute, native::NativeStore};

fn budget(provider: &str, model: &str) -> Value {
    json!({"provider":provider,"model":model,"max_requests":144,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":50000000,"pricing":{"input_microusd_per_million":250000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"}})
}
fn fixture(specialist: Option<&str>, requested: Value) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(&db,json!({"op":"init","now":1,"id":"repo","name":"Guide","remote":{"namespace":"test","name":"repo"},"commit":"a".repeat(40),"policy":{"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/tasks.mjs"],"timeout_seconds":30}]}}})).unwrap();
    let mut adaptive = json!({"version":1,"requested_agents":requested});
    if let Some(connection) = specialist {
        adaptive["specialist_connection"] = json!(connection);
    }
    execute(&db, json!({"op":"start_run","_workspace":"_admin","now":2,"id":"run","intent":"Build a task board","mode":"collaborate","agents":[{"connection":"glm","provider":"zai","model":"glm-5.3-flash","role_hint":"backend","strategy":"backend team participant 1"}],"adaptive_team":adaptive,"_approved_model_pool":[{"connection":"glm","provider":"zai","model":"glm-5.3-flash"},{"connection":"codex","provider":"codex","model":"gpt-5.6-luna"}],"model_budgets":[budget("zai","glm-5.3-flash"),budget("codex","gpt-5.6-luna")]})).unwrap();
    execute(
        &db,
        json!({"op":"claim","job_id":"job:run:planner","now":3}),
    )
    .unwrap();
    db
}
fn guided() -> NativeStore {
    fixture(
        Some("codex"),
        json!([{"connection":null,"role":"backend"},{"connection":null,"role":"frontend"}]),
    )
}
fn plan(integrator: usize) -> Value {
    json!({"version":1,"contract":"tasks API","integrator_agent":integrator,"integration_paths":["public/"],"tasks":[{"id":"behavior","title":"Behavior","instructions":"Implement behavior","agent":0,"depends_on":[],"write_paths":["public/tasks.mjs"]},{"id":"interface","title":"Interface","instructions":"Implement UI","agent":1,"depends_on":[],"write_paths":["public/app.mjs"]}]})
}
fn propose(agents: Value, integrator: usize) -> Value {
    json!({"op":"team_plan_propose","job_id":"job:run:planner","epoch":1,"now":4,"agents":agents,"plan":plan(integrator)})
}
fn glm_pair() -> Value {
    json!([{"connection":"glm","role":"backend"},{"connection":"glm","role":"frontend"}])
}
fn finish(db: &NativeStore) -> Value {
    execute(db,json!({"op":"finish","job_id":"job:run:planner","epoch":1,"now":5,"result":{"planning":true,"source_unchanged":true}})).unwrap();
    get(db, "runs", "run").unwrap()
}
fn connections(agents: &Value) -> Vec<&str> {
    agents
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["connection"].as_str().unwrap())
        .collect()
}

#[test]
fn specialists_move_to_the_approved_connection_and_integration_keeps_the_planned_model() {
    let db = guided();
    let proposal = execute(&db, propose(glm_pair(), 0)).unwrap();
    assert_eq!(
        connections(&proposal["data"]["agents"]),
        ["codex", "codex", "glm"]
    );
    assert_eq!(proposal["data"]["agents"][2]["role_hint"], "auto");
    assert_eq!(proposal["data"]["plan"]["integrator_agent"], 2);
    // Identical resubmission is deterministic and idempotent.
    assert_eq!(
        execute(&db, propose(glm_pair(), 0)).unwrap()["id"],
        proposal["id"]
    );
    let run = finish(&db);
    assert_eq!(run["team_plan"]["integrator_agent"], 2);
    for task in ["behavior", "interface"] {
        let execution =
            &get(&db, "jobs", &format!("job:run:task:{task}")).unwrap()["payload"]["execution"];
        assert_eq!(execution["provider"], "codex");
        assert_eq!(execution["model"], "gpt-5.6-luna");
    }
    assert_eq!(
        get(&db, "team_tasks", "run:task:integrate").unwrap()["agent"],
        2
    );
    assert_eq!(run["agents"][2]["provider"], "zai");
    let planner = &get(&db, "jobs", "job:run:planner").unwrap()["payload"]["execution"];
    assert_eq!(planner["provider"], "zai");
}

#[test]
fn a_separate_integrator_slot_is_kept_and_omitted_rosters_are_normalized_too() {
    let db = guided();
    let mut command = propose(
        json!([{"connection":"glm","role":"backend"},{"connection":"glm","role":"frontend"},{"connection":"glm","role":"builder"}]),
        2,
    );
    command["plan"]["integration_paths"] = json!(["public/"]);
    let proposal = execute(&db, command).unwrap();
    assert_eq!(
        connections(&proposal["data"]["agents"]),
        ["codex", "codex", "glm"]
    );
    assert_eq!(proposal["data"]["agents"][2]["role_hint"], "builder");

    let db = guided();
    let mut omitted = propose(json!(null), 1);
    omitted.as_object_mut().unwrap().remove("agents");
    let proposal = execute(&db, omitted).unwrap();
    assert_eq!(
        connections(&proposal["data"]["agents"]),
        ["codex", "codex", "glm"]
    );
    assert_eq!(proposal["data"]["plan"]["integrator_agent"], 2);
}

#[test]
fn without_an_approved_specialist_or_its_budget_the_planned_roster_is_unchanged() {
    let db = fixture(
        None,
        json!([{"connection":null,"role":"backend"},{"connection":null,"role":"frontend"}]),
    );
    let proposal = execute(&db, propose(glm_pair(), 0)).unwrap();
    assert_eq!(connections(&proposal["data"]["agents"]), ["glm", "glm"]);
    assert_eq!(proposal["data"]["plan"]["integrator_agent"], 0);

    let db = guided();
    let mut run = get(&db, "runs", "run").unwrap();
    run["unavailable_model_groups"] = json!([{"provider":"codex","model":"gpt-5.6-luna"}]);
    save(&db, "runs", "run", &run).unwrap();
    let proposal = execute(&db, propose(glm_pair(), 0)).unwrap();
    assert_eq!(connections(&proposal["data"]["agents"]), ["glm", "glm"]);
}

#[test]
fn explicit_owner_rows_are_kept_and_a_full_roster_never_moves_the_integrator() {
    let db = fixture(
        Some("codex"),
        json!([{"connection":"glm","role":"backend"},{"connection":null,"role":"frontend"}]),
    );
    let proposal = execute(&db, propose(glm_pair(), 0)).unwrap();
    assert_eq!(connections(&proposal["data"]["agents"]), ["glm", "codex"]);

    let db = guided();
    let roster: Vec<Value> = ["backend", "frontend", "auto", "auto", "auto", "auto"]
        .iter()
        .map(|role| json!({"connection":"glm","role":role}))
        .collect();
    let tasks: Vec<Value> = (0..6)
        .map(|i| json!({"id":format!("t{i}"),"title":"Task","instructions":"Work","agent":i,"depends_on":[],"write_paths":[format!("public/f{i}.mjs")]}))
        .collect();
    let mut command = propose(json!(roster), 0);
    command["plan"]["tasks"] = json!(tasks);
    let proposal = execute(&db, command).unwrap();
    assert_eq!(
        connections(&proposal["data"]["agents"]),
        ["glm", "codex", "codex", "codex", "codex", "codex"]
    );
    assert_eq!(proposal["data"]["plan"]["integrator_agent"], 0);
}

#[test]
fn a_specialist_without_an_approved_budget_is_refused_before_the_run_starts() {
    let db = NativeStore::memory().unwrap();
    execute(&db,json!({"op":"init","now":1,"id":"repo","name":"Guide","remote":{"namespace":"test","name":"repo"},"commit":"a".repeat(40),"policy":{"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/tasks.mjs"],"timeout_seconds":30}]}}})).unwrap();
    let error = execute(&db, json!({"op":"start_run","_workspace":"_admin","now":2,"id":"run","intent":"Build a task board","mode":"collaborate","agents":[{"connection":"glm","provider":"zai","model":"glm-5.3-flash","role_hint":"backend","strategy":"backend team participant 1"}],"adaptive_team":{"version":1,"requested_agents":[{"connection":null,"role":"backend"}],"specialist_connection":"codex"},"_approved_model_pool":[{"connection":"glm","provider":"zai","model":"glm-5.3-flash"},{"connection":"codex","provider":"codex","model":"gpt-5.6-luna"}],"model_budgets":[budget("zai","glm-5.3-flash")]})).unwrap_err();
    assert_eq!(error.code, "INVALID_INPUT", "{}", error.message);
    assert!(get(&db, "runs", "run").is_err());
}
