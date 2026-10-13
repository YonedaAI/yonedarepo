use serde_json::{Value, json};
use yoneda_app::native::NativeStore;

use super::{model_budget, timeout_ms};

fn call(db: &NativeStore, mut command: Value) -> Value {
    command["now"] = json!(1000);
    yoneda_app::execute(db, command).unwrap()
}

fn comparison() -> (NativeStore, Vec<Value>) {
    let db = NativeStore::memory().unwrap();
    call(
        &db,
        json!({"op":"init","id":"comparison-phases","name":"Phase boundary regression",
        "remote":{"namespace":"test","name":"comparison-phases"},"commit":"a".repeat(40),
        "policy":{"version":"compare-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1",
            "required_checks":["build"],"build":{"checks":[{"name":"build","argv":["node","--check","app.js"],"timeout_seconds":30}]}}}),
    );
    let budget = json!({"provider":"zai","model":"glm-5.3-flash","max_requests":144,
        "max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":50000000,
        "pricing":{"input_microusd_per_million":150000,"output_microusd_per_million":500000,"source":"owner-approved conservative rates"}});
    let reviewer = json!({"provider":"zai","model":"glm-5.3-flash","connection":"saved"});
    call(
        &db,
        json!({"op":"start_run","id":"compare","mode":"compare","comparison":{"version":1},
        "intent":"Compare two safe booking implementations","agents":[
            {"provider":"zai","model":"glm-5.3-flash","connection":"saved","strategy":"minimal"},
            {"provider":"zai","model":"glm-5.3-flash","connection":"saved","strategy":"defensive"}],
        "_comparison_reviewer":reviewer,"_comparison_reviewer_budget":budget,"model_budgets":[budget]}),
    );
    let builders = (1..=2)
        .map(|index| {
            call(
                &db,
                json!({"op":"claim","job_id":format!("job:compare:agent-{index}")}),
            )
        })
        .collect();
    (db, builders)
}

#[test]
fn comparison_phase_capture_from_actual_ledger_finish_ignores_inference_budget_after_33_requests() {
    let (db, builders) = comparison();
    for (index, job) in builders.iter().enumerate() {
        for _ in 0..if index == 0 { 17 } else { 16 } {
            let reserved = call(
                &db,
                json!({"op":"reserve_request","job_id":job["id"],"epoch":job["epoch"],
                "kind":"model","input_bytes":100,"output_tokens":256}),
            );
            call(
                &db,
                json!({"op":"settle_model_request","job_id":job["id"],"epoch":job["epoch"],
                "reservation_id":reserved["reservation_id"],"input_tokens":100,"output_tokens":1}),
            );
        }
    }
    let detail = call(&db, json!({"op":"run_detail","run_id":"compare"}));
    assert_eq!(detail["run"]["model_requests"], 33);
    assert_eq!(detail["run"]["model_budgets"][0]["requests"], 33);
    assert!(
        detail["run"]["model_budgets"][0]["charged_microusd"]
            .as_i64()
            .unwrap()
            > 0
    );
    for (index, job) in builders.iter().enumerate() {
        assert_eq!(job["payload"]["run"]["model_budgets"][0]["requests"], 0);
        assert_eq!(model_budget(job).unwrap().unwrap().requests, 0);
        assert_eq!(timeout_ms(job).unwrap(), 590000);
        call(
            &db,
            json!({"op":"hint_complete","job_id":job["id"],"epoch":job["epoch"],"summary":"Ready for independent capture"}),
        );
        call(
            &db,
            json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],"result":{"workspace":"e".repeat(64)}}),
        );
        let capture = call(
            &db,
            json!({"op":"claim","job_id":format!("capture:compare:agent-{}",index+1)}),
        );
        assert_eq!(capture["kind"], "capture");
        assert!(capture["payload"]["run"].is_null());
        assert_eq!(
            capture["payload"]["execution"]["comparison_approval_id"],
            job["payload"]["execution"]["comparison_approval_id"]
        );
        assert_eq!(timeout_ms(&capture).unwrap(), 570000);
        call(
            &db,
            json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],
            "result":{"id":format!("candidate-{}",index+1),"revision":{"repository":"test/candidate","commit":if index==0 {"b".repeat(40)}else{"c".repeat(40)}},
                "tree":"f".repeat(40),"paths":["app.js"],"summary":"Captured synthetic source"}}),
        );
        let evaluation = call(
            &db,
            json!({"op":"claim","job_id":format!("evaluate:candidate-{}",index+1)}),
        );
        assert_eq!(timeout_ms(&evaluation).unwrap(), 110000);
    }
    let after = call(&db, json!({"op":"run_detail","run_id":"compare"}));
    assert_eq!(
        after["run"]["model_budgets"],
        detail["run"]["model_budgets"]
    );
    assert_eq!(after["candidates"].as_array().unwrap().len(), 2);
}

#[test]
fn comparison_phase_publish_keeps_non_inference_timeout_without_run_approval() {
    let job = json!({"kind":"publish","payload":{"execution":{"comparison_approval_id":"approval-without-run"}}});
    assert_eq!(timeout_ms(&job).unwrap(), 570000);
}

#[test]
fn comparison_phase_agent_and_kindless_prompt_still_fence_changed_or_missing_approval() {
    let (_, builders) = comparison();
    let original = &builders[0];
    assert_eq!(timeout_ms(original).unwrap(), 590000);
    for kindless in [false, true] {
        let mut forged = original.clone();
        if kindless {
            forged.as_object_mut().unwrap().remove("kind");
        }
        forged["payload"]["run"]["comparison"]["approval"]["id"] = json!("other-approval");
        assert_eq!(model_budget(&forged).unwrap_err().code, "FENCED");
        if !kindless {
            assert_eq!(timeout_ms(&forged).unwrap_err().code, "FENCED");
        }
        forged["payload"]["run"] = Value::Null;
        assert_eq!(model_budget(&forged).unwrap_err().code, "FENCED");
    }
}
