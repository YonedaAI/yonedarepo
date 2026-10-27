use super::*;

fn configured() -> (NativeStore, Value) {
    let db = repo_with_policy(json!({"version":"build-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}));
    let command = json!({"op":"start_run","id":"budgeted","intent":"Build a useful website",
        "agents":[{"provider":"mimo","connection":"personal","model":"flash","strategy":"minimal"},
        {"provider":"mimo","connection":"team","model":"flash","strategy":"accessible"}],
        "model_budgets":[{"provider":"mimo","model":"flash","max_requests":40,"max_output_tokens":512,
        "max_execution_ms":60000,"spend_limit_microusd":null,"pricing":null,"requests":0,"charged_microusd":0}]});
    (db, command)
}
fn priced(command: &mut Value, limit: i64) {
    command["model_budgets"][0]["spend_limit_microusd"] = json!(limit);
    command["model_budgets"][0]["pricing"] = json!({"input_microusd_per_million":1000000,
        "output_microusd_per_million":2000000,"source":"owner-approved conservative rates"});
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
        14
    );
    assert!(
        db.query("SELECT id FROM model_reservations", &[])
            .unwrap()
            .is_empty()
    );
}
