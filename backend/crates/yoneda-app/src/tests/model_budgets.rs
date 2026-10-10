use super::*;

fn configured() -> (NativeStore, Value) {
    let db = repo_with_policy(json!({"version":"build-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}));
    let command = json!({"op":"start_run","id":"budgeted","intent":"Build a useful website",
        "agents":[{"provider":"mimo","connection":"personal","model":"flash","strategy":"minimal"},
        {"provider":"mimo","connection":"team","model":"flash","strategy":"accessible"}],
        "delegation":{"enabled":true,"max_depth":2,"max_executions":12},
        "model_budgets":[{"provider":"mimo","model":"flash","max_requests":40,"max_output_tokens":512,
        "max_execution_ms":60000,"spend_limit_microusd":null,"pricing":null,"requests":0,"charged_microusd":0}]});
    (db, command)
}
fn claim(db: &NativeStore, id: &str, now: i64) -> Value {
    call(db, json!({"op":"claim","job_id":id,"now":now})).unwrap()
}
fn reserve(db: &NativeStore, id: &str, epoch: i64) -> Result<Value> {
    call(
        db,
        json!({"op":"reserve_request","kind":"model","job_id":id,"epoch":epoch,"input_bytes":100,"output_tokens":512}),
    )
}
fn budget(db: &NativeStore) -> Value {
    call(db, json!({"op":"snapshot"})).unwrap()["runs"][0]["model_budgets"][0].clone()
}
fn priced(command: &mut Value, limit: i64) {
    command["model_budgets"][0]["spend_limit_microusd"] = json!(limit);
    command["model_budgets"][0]["pricing"] = json!({"input_microusd_per_million":1000000,
        "output_microusd_per_million":2000000,"source":"owner-approved conservative rates"});
}

#[test]
fn model_budgets_long_execution_survives_queue_delay_and_fences_at_approved_deadline() {
    let (db, mut command) = configured();
    command["model_budgets"][0]["max_execution_ms"] = json!(1_800_000);
    call(&db, command).unwrap();
    let root = "job:budgeted:agent-1";
    let claimed = claim(&db, root, 601_000);
    assert_eq!(claimed["attempt_deadline"], 2_521_000);
    call(
        &db,
        json!({"op":"progress","job_id":root,"epoch":1,"now":602_000,
        "progress":{"stage":"container_ready"}}),
    )
    .unwrap();
    for now in (650_000..2_402_000).step_by(50_000) {
        call(
            &db,
            json!({"op":"heartbeat","job_id":root,"epoch":1,"now":now}),
        )
        .unwrap();
    }
    assert_eq!(
        call(
            &db,
            json!({"op":"check_attempt","job_id":root,"epoch":1,"now":2_401_999})
        )
        .unwrap()["deadline"],
        2_402_000
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"check_attempt","job_id":root,"epoch":1,"now":2_402_000})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"claim","job_id":"job:budgeted:agent-2","now":1_201_000})
        )
        .unwrap_err()
        .code,
        "ATTEMPTS_EXHAUSTED"
    );
}

#[test]
fn model_budgets_validate_exact_groups_and_reject_tampered_usage_atomically() {
    for case in 0..12 {
        let (db, mut command) = configured();
        match case {
            0 => command["model_budgets"][0]["requests"] = json!(1),
            1 => command["model_budgets"][0]["charged_microusd"] = json!(1),
            2 => command["model_budgets"][0]["model"] = json!("unused-model"),
            3 => command["model_budgets"] = json!([]),
            4 => {
                command["model_budgets"] = json!([
                    command["model_budgets"][0].clone(),
                    command["model_budgets"][0].clone()
                ])
            }
            5 => command["model_budgets"][0]["max_requests"] = json!(0),
            6 => command["model_budgets"][0]["max_output_tokens"] = json!(4097),
            7 => command["model_budgets"][0]["max_execution_ms"] = json!(59999),
            8 => command["model_budgets"][0]["spend_limit_microusd"] = json!(1),
            9 => {
                priced(&mut command, 10000);
                command["model_budgets"][0]["pricing"]["source"] = json!("agent assertion");
            }
            10 => {
                priced(&mut command, 10000);
                command["model_budgets"][0]["pricing"]["input_microusd_per_million"] = json!(-1);
            }
            _ => command["model_budgets"][0]["extra_usage"] = json!(0),
        }
        let before = call(&db, json!({"op":"snapshot"})).unwrap();
        assert_eq!(
            call(&db, command).unwrap_err().code,
            "INVALID_INPUT",
            "case {case}"
        );
        assert_eq!(
            call(&db, json!({"op":"snapshot"})).unwrap(),
            before,
            "case {case}"
        );
    }
}

#[test]
fn model_budgets_share_requests_across_connections_subagents_and_retries() {
    let (db, mut command) = configured();
    command["model_budgets"][0]["max_requests"] = json!(3);
    call(&db, command).unwrap();
    let root = "job:budgeted:agent-1";
    claim(&db, root, 1000);
    let child = call(
        &db,
        json!({"op":"delegate_agent","job_id":root,"epoch":1,"request_id":"child",
        "task":"Build another independent alternative","strategy":"accessible"}),
    )
    .unwrap();
    let child_job = child["job_id"].as_str().unwrap();
    assert_eq!(
        child["execution"]["budget"],
        json!({"provider":"mimo","model":"flash"})
    );
    claim(&db, child_job, 1000);
    assert_eq!(
        reserve(&db, root, 1).unwrap()["model_budget"]["requests"],
        1
    );
    assert_eq!(
        reserve(&db, child_job, 1).unwrap()["model_budget"]["requests"],
        2
    );
    call(
        &db,
        json!({"op":"fail","job_id":root,"epoch":1,"retryable":true,"error":"Restart transport"}),
    )
    .unwrap();
    claim(&db, root, 1000);
    assert_eq!(
        reserve(&db, root, 2).unwrap()["model_budget"]["requests"],
        3
    );
    let other = "job:budgeted:agent-2";
    claim(&db, other, 1000);
    assert_eq!(
        reserve(&db, other, 1).unwrap_err().code,
        "MODEL_REQUEST_LIMIT"
    );
    assert_eq!(budget(&db)["requests"], 3);
}

#[test]
fn model_budgets_replace_hidden_per_job_limit_and_enforce_output_ceiling() {
    let (db, command) = configured();
    call(&db, command).unwrap();
    let root = "job:budgeted:agent-1";
    claim(&db, root, 1000);
    for number in 1..=27 {
        assert_eq!(reserve(&db, root, 1).unwrap()["number"], number);
    }
    let before = budget(&db);
    for c in [
        json!({"output_tokens":513,"input_bytes":100}),
        json!({"output_tokens":0,"input_bytes":100}),
        json!({"output_tokens":512,"input_bytes":262145}),
    ] {
        assert_eq!(
            call(
                &db,
                json!({"op":"reserve_request","kind":"model","job_id":root,"epoch":1,
            "output_tokens":c["output_tokens"],"input_bytes":c["input_bytes"]})
            )
            .unwrap_err()
            .code,
            "INVALID_INPUT"
        );
    }
    assert_eq!(budget(&db), before);
    assert_eq!(
        call(
            &db,
            json!({"op":"reserve_request","kind":"model","job_id":root,"epoch":1,
        "output_tokens":0,"input_bytes":100,"count_only":true})
        )
        .unwrap()["reservation_microusd"],
        0
    );
}

#[test]
fn historical_model_budgets_distinct_groups_still_share_the_run_request_maximum() {
    let (db, mut command) = configured();
    command["agents"][1]["model"] = json!("second-model");
    command["model_budgets"][0]["max_requests"] = json!(144);
    let mut second = command["model_budgets"][0].clone();
    second["model"] = json!("second-model");
    command["model_budgets"]
        .as_array_mut()
        .unwrap()
        .push(second);
    call(&db, command).unwrap();
    let first = "job:budgeted:agent-1";
    // Recreate a pre-optional-policy run; its recorded ceiling must not change on upgrade.
    db.query(
        "UPDATE runs SET payload=json_remove(payload,'$.request_limits')",
        &[],
    )
    .unwrap();
    let second = "job:budgeted:agent-2";
    claim(&db, first, 1000);
    claim(&db, second, 1000);
    for _ in 0..100 {
        reserve(&db, first, 1).unwrap();
    }
    for _ in 0..44 {
        reserve(&db, second, 1).unwrap();
    }
    assert_eq!(reserve(&db, second, 1).unwrap_err().code, "RESOURCE_LIMIT");
    let run = call(&db, json!({"op":"snapshot"})).unwrap()["runs"][0].clone();
    assert_eq!(run["model_requests"], 144);
    assert_eq!(run["model_budgets"][0]["requests"], 100);
    assert_eq!(run["model_budgets"][1]["requests"], 44);
}

#[test]
fn new_runs_default_to_no_request_cap_and_continue_past_old_limits() {
    let (db, mut command) = configured();
    command.as_object_mut().unwrap().remove("model_budgets");
    call(&db, command).unwrap();
    let root = "job:budgeted:agent-1";
    claim(&db, root, 1000);
    for number in 1..=150 {
        assert_eq!(reserve(&db, root, 1).unwrap()["number"], number);
    }
    assert_eq!(budget(&db)["max_requests"], Value::Null);
    assert_eq!(budget(&db)["requests"], 150);
}

#[test]
fn model_budgets_unknown_usage_retains_money_and_late_settlement_refunds_once() {
    let (db, mut command) = configured();
    priced(&mut command, 10000);
    call(&db, command).unwrap();
    let root = "job:budgeted:agent-1";
    claim(&db, root, 1000);
    let reservation = reserve(&db, root, 1).unwrap();
    assert_eq!(reservation["reservation_microusd"], 9316);
    assert_eq!(budget(&db)["charged_microusd"], 9316);
    assert_eq!(reserve(&db, root, 1).unwrap_err().code, "MODEL_SPEND_LIMIT");
    assert_eq!(budget(&db)["requests"], 1);
    call(&db, json!({"op":"recover","now":122000})).unwrap();
    claim(&db, root, 122000);
    let settlement = json!({"op":"settle_model_request","job_id":root,"epoch":1,
        "reservation_id":reservation["reservation_id"],"input_tokens":10,"output_tokens":5,"now":300000});
    let settled = call(&db, settlement.clone()).unwrap();
    assert_eq!(settled["charged_microusd"], 20);
    assert_eq!(budget(&db)["charged_microusd"], 20);
    let sequence = call(&db, json!({"op":"snapshot"})).unwrap()["seq"].clone();
    assert_eq!(call(&db, settlement.clone()).unwrap(), settled);
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["seq"],
        sequence
    );
    let mut conflicting = settlement.clone();
    conflicting["input_tokens"] = json!(11);
    assert_eq!(
        call(&db, conflicting).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
    for (field, value) in [
        ("job_id", json!("job:budgeted:agent-2")),
        ("epoch", json!(2)),
    ] {
        let mut wrong = settlement.clone();
        wrong[field] = value;
        assert_eq!(call(&db, wrong).unwrap_err().code, "FORBIDDEN");
    }
    assert_eq!(budget(&db)["charged_microusd"], 20);
}

#[test]
fn model_budgets_invalid_usage_never_refunds_and_integer_rounding_is_conservative() {
    let (db, mut command) = configured();
    priced(&mut command, 10000);
    command["model_budgets"][0]["pricing"]["input_microusd_per_million"] = json!(3);
    command["model_budgets"][0]["pricing"]["output_microusd_per_million"] = json!(7);
    call(&db, command).unwrap();
    let root = "job:budgeted:agent-1";
    claim(&db, root, 1000);
    let reservation = reserve(&db, root, 1).unwrap();
    assert_eq!(reservation["reservation_microusd"], 1);
    for (input, output) in [(-1, 0), (0, -1), (8293, 0), (0, 513)] {
        assert_eq!(call(&db,json!({"op":"settle_model_request","job_id":root,"epoch":1,
            "reservation_id":reservation["reservation_id"],"input_tokens":input,"output_tokens":output})).unwrap_err().code,"INVALID_INPUT");
    }
    assert_eq!(budget(&db)["charged_microusd"], 1);
}

#[test]
fn model_budgets_claims_and_heartbeats_honor_approved_duration_without_extending_it() {
    let (db, command) = configured();
    call(&db, command).unwrap();
    let root = "job:budgeted:agent-1";
    assert_eq!(claim(&db, root, 1000)["attempt_deadline"], 181000);
    call(&db,json!({"op":"progress","job_id":root,"epoch":1,"now":1500,"progress":{"stage":"container_ready"}})).unwrap();
    assert_eq!(
        call(
            &db,
            json!({"op":"check_attempt","job_id":root,"epoch":1,"now":50000})
        )
        .unwrap()["deadline"],
        61500
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"heartbeat","job_id":root,"epoch":1,"now":50000})
        )
        .unwrap()["lease_until"],
        61500
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"check_attempt","job_id":root,"epoch":1,"now":61500})
        )
        .unwrap_err()
        .code,
        "FENCED"
    );
}

#[test]
fn model_budgets_migration_upgrades_version_four_and_is_repeatable() {
    let (db, command) = configured();
    call(&db, command).unwrap();
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    db.query("DROP TABLE model_reservations", &[]).unwrap();
    db.query("DELETE FROM schema_migrations WHERE version=5", &[])
        .unwrap();
    migrate(&db).unwrap();
    migrate(&db).unwrap();
    assert_eq!(call(&db, json!({"op":"snapshot"})).unwrap(), before);
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM schema_migrations", &[])
            .unwrap()[0]["count"],
        12
    );
    assert!(
        db.query("SELECT id FROM model_reservations", &[])
            .unwrap()
            .is_empty()
    );
}
