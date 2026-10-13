use crate::{execute, native::NativeStore, storage::*};
use serde_json::json;

fn fixture(mode: &str) -> NativeStore {
    fixture_settings(mode, true)
}

fn fixture_settings(mode: &str, explicit: bool) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(&db,json!({"op":"init","now":1,"id":"repo","name":"Fixed reasoning","remote":{"namespace":"test","name":"repo"},"commit":"a".repeat(40),"policy":{"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["build"],"build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","src/index.js"],"timeout_seconds":30}]}}})).unwrap();
    let mut c = json!({"op":"start_run","now":2,"id":"run","mode":mode,"intent":"Implement keyboard source search","agents":[{"provider":"codex","connection":"codex-profile","model":"gpt-5.6-luna","strategy":"Keyboard implementation","reasoning_effort":"high"},{"provider":"claude","connection":"claude-profile","model":"claude-sonnet-5-5","strategy":"Search implementation","reasoning_effort":"high"}]});
    if !explicit {
        for agent in c["agents"].as_array_mut().unwrap() {
            agent.as_object_mut().unwrap().remove("reasoning_effort");
        }
    }
    if mode == "compare" {
        c["delegation"] = json!({"enabled":true,"max_depth":1,"max_executions":4});
    }
    if mode == "collaborate" {
        c["team"] = json!({"version":1,"contract":"Search shared contract","integrator_agent":1,"integration_paths":["src/"],"tasks":[{"id":"ui","title":"UI","instructions":"Implement keyboard UI","agent":0,"depends_on":[],"write_paths":["src/ui.rs"]},{"id":"api","title":"API","instructions":"Implement search API","agent":1,"depends_on":[],"write_paths":["src/api.rs"]}]});
    }
    execute(&db, c).unwrap();
    db
}

#[test]
fn fixed_compare_approved_effort_reaches_root_jobs_and_runtime_authority() {
    let db = fixture("compare");
    let run = get(&db, "runs", "run").unwrap();
    for index in 1..=2 {
        let job = get(&db, "jobs", &format!("job:run:agent-{index}")).unwrap();
        assert_eq!(job["payload"]["execution"]["reasoning_effort"], "high");
        assert_eq!(
            yoneda_core::adaptive_team::execution_effort(&run, &job["payload"]["execution"])
                .unwrap(),
            Some("high")
        );
    }
}

#[test]
fn fixed_manual_team_approved_effort_reaches_specialists_and_integrator() {
    let db = fixture("collaborate");
    let run = get(&db, "runs", "run").unwrap();
    for task in ["ui", "api"] {
        let job = get(&db, "jobs", &format!("job:run:task:{task}")).unwrap();
        assert_eq!(job["payload"]["execution"]["reasoning_effort"], "high");
        assert_eq!(
            yoneda_core::adaptive_team::execution_effort(&run, &job["payload"]["execution"])
                .unwrap(),
            Some("high")
        );
    }
    // Complete trusted native capture handoffs so the real scheduler creates integration.
    for (index, task) in ["ui", "api"].iter().enumerate() {
        let job_id = format!("job:run:task:{task}");
        execute(
            &db,
            json!({"op":"claim","job_id":job_id,"now":3+index as i64*4}),
        )
        .unwrap();
        execute(&db,json!({"op":"finish","job_id":job_id,"epoch":1,"now":4+index as i64*4,"result":{"workspace":"b".repeat(64),"transcript":"c".repeat(64)}})).unwrap();
        let capture = format!("capture:run:task:{task}");
        execute(
            &db,
            json!({"op":"claim","job_id":capture,"now":5+index as i64*4}),
        )
        .unwrap();
        execute(&db,json!({"op":"finish","job_id":capture,"epoch":1,"now":6+index as i64*4,"result":{"id":format!("candidate:{task}"),"revision":{"repository":format!("test/{task}"),"commit":"d".repeat(40)},"tree":"e".repeat(40),"paths":[format!("src/{task}.rs")],"summary":"Native fixture capture"}})).unwrap();
    }
    let job = get(&db, "jobs", "job:run:task:integrate").unwrap();
    assert_eq!(job["payload"]["execution"]["reasoning_effort"], "high");
    assert_eq!(
        yoneda_core::adaptive_team::execution_effort(&run, &job["payload"]["execution"]).unwrap(),
        Some("high")
    );
}

#[test]
fn fixed_reasoning_forged_job_is_rejected_before_request_counter_changes() {
    let db = fixture("compare");
    execute(
        &db,
        json!({"op":"claim","job_id":"job:run:agent-1","now":3}),
    )
    .unwrap();
    let mut job = get(&db, "jobs", "job:run:agent-1").unwrap();
    job["payload"]["execution"]["reasoning_effort"] = json!("max");
    save(&db, "jobs", "job:run:agent-1", &job).unwrap();
    let before = get(&db, "runs", "run").unwrap();
    assert_eq!(execute(&db,json!({"op":"reserve_request","job_id":"job:run:agent-1","epoch":1,"kind":"model","input_bytes":100,"output_tokens":256,"now":4})).unwrap_err().code,"FENCED");
    assert_eq!(get(&db, "runs", "run").unwrap(), before);
    assert_eq!(get(&db, "jobs", "job:run:agent-1").unwrap(), job);
}

#[test]
fn fixed_delegation_inherits_exact_effort_and_original_model_without_approval_mutation() {
    let db = fixture("compare");
    execute(
        &db,
        json!({"op":"claim","job_id":"job:run:agent-1","now":3}),
    )
    .unwrap();
    let before = get(&db, "runs", "run").unwrap();
    let receipt=execute(&db,json!({"op":"delegate_agent","job_id":"job:run:agent-1","epoch":1,"now":4,"request_id":"delegated-source-check","task":"Check keyboard search independently","strategy":"Scoped delegated check"})).unwrap();
    let e = &receipt["execution"];
    assert_eq!(e["reasoning_effort"], "high");
    assert_eq!(e["agent_index"], 0);
    assert_eq!(e["model"], before["agents"][0]["model"]);
    assert_eq!(
        yoneda_core::adaptive_team::execution_effort(&before, e).unwrap(),
        Some("high")
    );
    let after = get(&db, "runs", "run").unwrap();
    for field in ["agents", "model_budgets", "delegation", "policy"] {
        assert_eq!(after[field], before[field]);
    }
    let job = get(&db, "jobs", receipt["job_id"].as_str().unwrap()).unwrap();
    assert_eq!(job["payload"]["execution"]["reasoning_effort"], "high");
}

#[test]
fn fixed_delegation_does_not_reuse_reasoning_slot_after_parent_model_substitution() {
    let db = fixture("compare");
    execute(
        &db,
        json!({"op":"claim","job_id":"job:run:agent-1","now":3}),
    )
    .unwrap();
    let before = get(&db, "runs", "run").unwrap();
    let mut parent = get(&db, "executions", "run:agent-1").unwrap();
    parent["model"] = json!("gpt-6-luna");
    save(&db, "executions", "run:agent-1", &parent).unwrap();
    assert_eq!(execute(&db,json!({"op":"delegate_agent","job_id":"job:run:agent-1","epoch":1,"now":4,"request_id":"delegated-source-check","task":"Check search independently","strategy":"Scoped delegated check"})).unwrap_err().code,"FENCED");
    assert_eq!(get(&db, "runs", "run").unwrap(), before);
    assert_eq!(all(&db, "executions").unwrap().len(), 2);
}

#[test]
fn fixed_auto_default_jobs_and_delegation_do_not_gain_effort_authority() {
    let db = fixture_settings("compare", false);
    execute(
        &db,
        json!({"op":"claim","job_id":"job:run:agent-1","now":3}),
    )
    .unwrap();
    let run = get(&db, "runs", "run").unwrap();
    let job = get(&db, "jobs", "job:run:agent-1").unwrap();
    assert!(job["payload"]["execution"]["reasoning_effort"].is_null());
    assert_eq!(
        yoneda_core::adaptive_team::execution_effort(&run, &job["payload"]["execution"]).unwrap(),
        None
    );
    let child=execute(&db,json!({"op":"delegate_agent","job_id":"job:run:agent-1","epoch":1,"now":4,"request_id":"delegated-auto-source","task":"Check search independently","strategy":"Scoped delegated check"})).unwrap();
    assert!(child["execution"]["reasoning_effort"].is_null());
    assert_eq!(
        yoneda_core::adaptive_team::execution_effort(&run, &child["execution"]).unwrap(),
        None
    );
}
