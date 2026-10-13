use super::*;
use crate::{execute, native::NativeStore};

fn budget(provider: &str, model: &str) -> Value {
    json!({"provider":provider,"model":model,"max_requests":8,"max_output_tokens":4096,
        "max_execution_ms":600000,"spend_limit_microusd":5000000,
        "pricing":{"input_microusd_per_million":8000000,"output_microusd_per_million":20000000,"source":"owner-approved conservative rates"}})
}
fn fixture() -> (NativeStore, Value) {
    let db = NativeStore::memory().unwrap();
    execute(&db, json!({"op":"init","now":1000,"id":"booking","workspace":"reviewer",
        "name":"Synthetic booking","remote":{"namespace":"test","name":"booking"},
        "commit":"a".repeat(40),"policy":{"version":"v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1",
        "required_checks":["test"],"build":{"checks":[{"name":"test","argv":["true"],"timeout_seconds":30}]}}})).unwrap();
    let cheap = budget("codex", "gpt-5.6-luna");
    let opus = budget("claude", "claude-opus-5-5");
    let command = json!({"op":"start_run","now":1000,"id":"run","_workspace":"reviewer",
        "intent":"Approved original goal","mode":"collaborate",
        "agents":[{"provider":"codex","model":"gpt-5.6-luna","strategy":"API"},
        {"provider":"codex","model":"gpt-5.6-luna","strategy":"UI"}],
        "model_budgets":[cheap],"autonomy_policy":{"version":1,"enabled":true,"max_repair_rounds":2,
        "max_concurrent_agents":3,"max_executions":20,"source_scope":"project","allow_intent_questions":true},
        "repair_escalation":{"version":1,"provider":"claude","model":"claude-opus-5-5","connection":"approved-opus",
        "max_executions":1,"repair_round":2,"after_cheaper_repair_failure":true,"budget":opus},
        "campaign":{"id":"fresh","version":1,"chain_id":"run","bucket":"routine","purpose":"routine"}});
    (db, sign(command))
}
fn sign(mut command: Value) -> Value {
    let mut public = command.clone();
    for field in [
        "op",
        "now",
        "_workspace",
        "_campaign_grant",
        "_campaign_signing_key",
    ] {
        public.as_object_mut().unwrap().remove(field);
    }
    let claims = json!({"workspace":"reviewer","repo_id":"booking","run_id":command["id"],
        "campaign":command["campaign"],"model_budgets":[command["model_budgets"][0],command["repair_escalation"]["budget"]],
        "request_digest":yoneda_core::fingerprint(&public).unwrap(),"expires":61000});
    let key = "1".repeat(64);
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
    mac.update(
        format!(
            "yoneda:campaign-grant:v1\0{}",
            yoneda_core::fingerprint(&claims).unwrap()
        )
        .as_bytes(),
    );
    let signature: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    command["_campaign_grant"] = json!({"claims":claims,"signature":signature});
    command["_campaign_signing_key"] = json!(key);
    command
}
#[test]
fn signed_start_freezes_escalation_into_the_same_immutable_autonomy_envelope() {
    let (db, command) = fixture();
    let run = execute(&db, command).unwrap();
    assert_eq!(run["model_budgets"].as_array().unwrap().len(), 2);
    assert_eq!(
        run["autonomy_approval"]["model_budgets"],
        run["model_budgets"]
    );
    assert_eq!(
        run["autonomy_approval"]["repair_escalation"],
        run["repair_escalation"]
    );
    assert_eq!(run["autonomy_policy"]["max_repair_rounds"], 2);
    assert!(run.get("_campaign_grant").is_none());
    assert!(run.get("_campaign_signing_key").is_none());
    let job = get(&db, "jobs", "job:run:planner").unwrap();
    assert_eq!(
        job["payload"]["run"]["autonomy_approval"],
        run["autonomy_approval"]
    );
}
#[test]
fn reservation_returns_the_frozen_campaign_not_caller_fields() {
    let (db, command) = fixture();
    let campaign = command["campaign"].clone();
    let run = execute(&db, command).unwrap();
    let job = execute(
        &db,
        json!({"op":"claim","now":1001,"job_id":"job:run:planner"}),
    )
    .unwrap();
    assert_eq!(job["payload"]["run"]["campaign"], campaign);
    let reservation = execute(&db, json!({"op":"reserve_request","now":1002,
        "job_id":job["id"],"epoch":job["epoch"],"kind":"model",
        "input_bytes":100,"output_tokens":256,
        "campaign":{"id":"forged","version":99,"chain_id":"new","bucket":"reserve","purpose":"other"}})).unwrap();
    assert_eq!(reservation["campaign"], run["campaign"]);
    assert!(reservation.get("_campaign_grant").is_none());
    assert!(reservation.get("_campaign_signing_key").is_none());
}
#[test]
fn invalid_grants_roll_back_every_run_and_job() {
    let (db, command) = fixture();
    let alterations = [
        json!({"intent":"Unapproved goal"}),
        json!({"_campaign_grant":{"claims":command["_campaign_grant"]["claims"],"signature":"0".repeat(64)}}),
        json!({"_campaign_signing_key":"0".repeat(64)}),
        json!({"_workspace":"another-account"}),
        json!({"now":61000}),
        json!({"campaign":{"id":"other-budget","version":1,"chain_id":"run","bucket":"routine","purpose":"routine"}}),
    ];
    for alteration in alterations {
        let mut bad = command.clone();
        for (field, value) in alteration.as_object().unwrap() {
            bad[field] = value.clone();
        }
        assert_eq!(execute(&db, bad).unwrap_err().code, "FORBIDDEN");
        assert!(all(&db, "runs").unwrap().is_empty());
        assert!(all(&db, "executions").unwrap().is_empty());
    }
    let mut unsigned = command;
    unsigned.as_object_mut().unwrap().remove("_campaign_grant");
    assert_eq!(execute(&db, unsigned).unwrap_err().code, "FORBIDDEN");
}
#[test]
fn one_shot_hook_requires_round_one_failure_and_cannot_claim_a_second_execution() {
    let (db, command) = fixture();
    let mut run = execute(&db, command).unwrap();
    let original = run["autonomy_approval"].clone();
    let execution =
        json!({"id":"repair-two","run_id":"run","repair_round":2,"team_role":"specialist"});
    assert!(
        claim_escalation(&db, &run, &execution, 1001)
            .unwrap()
            .is_none()
    );
    run["team_repair_rounds"] = json!(2);
    run["team_repair_failure"] =
        json!({"round":1,"execution_id":"failed-cheaper","model":"gpt-5.6-luna"});
    save(&db, "runs", "run", &run).unwrap();
    let coordinator = json!({"id":"read-only","repair_round":2,"team_role":"coordinator"});
    assert!(
        claim_escalation(&db, &run, &coordinator, 1002)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        claim_escalation(&db, &run, &execution, 1003)
            .unwrap()
            .unwrap()["model"],
        "claude-opus-5-5"
    );
    let second = json!({"id":"second-premium","repair_round":2,"team_role":"resolver"});
    assert!(
        claim_escalation(&db, &run, &second, 1004)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        get(&db, "runs", "run").unwrap()["autonomy_approval"],
        original
    );
    assert_eq!(
        get(&db, "runs", "run").unwrap()["campaign_opus"]["execution_id"],
        "repair-two"
    );
}
