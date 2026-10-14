//! Guide v2 fixed plans start specialists immediately under the real guided scope protections.
use super::*;
use crate::{execute, native::NativeStore};

const PLANS: &str = include_str!("../../../../../yoneda-core/src/guided_plans.json");

fn budget(provider: &str, model: &str) -> Value {
    json!({"provider":provider,"model":model,"max_requests":144,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":50000000,"pricing":{"input_microusd_per_million":250000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"}})
}

#[test]
fn every_fixed_guided_plan_starts_codex_specialists_without_a_planner() {
    let data: Value = serde_json::from_str(PLANS).unwrap();
    for step in ["build", "extend", "concurrent"] {
        for (ordinal, entry) in data["steps"][step].as_array().unwrap().iter().enumerate() {
            let db = NativeStore::memory().unwrap();
            execute(&db,json!({"op":"init","now":1,"id":"repo","name":"Guide","remote":{"namespace":"test","name":"repo"},"commit":"a".repeat(40),"policy":{"version":"task-board-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["board"],"build":{"setup":[],"checks":[{"name":"board","argv":["node","/opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs"],"timeout_seconds":30}],"static_dir":"public","test_bundle":{"digest":"d".repeat(64),"protected_paths":["README.md",".yoneda-guided","fixtures/guided-task-board/oracle"]}}}})).unwrap();
            let plan = &entry["plan"];
            let agents: Vec<Value> = entry["roles"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(slot, role)| {
                    let specialist = plan["tasks"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|t| t["agent"] == slot);
                    let (connection, provider, model) = if specialist {
                        ("codex", "codex", "gpt-5.6-luna")
                    } else {
                        ("glm", "zai", "glm-5.3-flash")
                    };
                    json!({"connection":connection,"provider":provider,"model":model,"role_hint":role,"strategy":format!("{} team participant {}", role.as_str().unwrap(), slot + 1)})
                })
                .collect();
            let rid = format!("run-{step}-{ordinal}");
            let run = execute(&db, json!({"op":"start_run","_workspace":"_admin","now":2,"id":rid,"intent":"Guided step","mode":"collaborate","agents":agents,"team":plan,"model_budgets":[budget("codex","gpt-5.6-luna"),budget("zai","glm-5.3-flash")],"delegation":{"enabled":false,"max_depth":0,"max_executions":agents.len()},"autonomy_policy":{"version":1,"enabled":true,"max_repair_rounds":2,"max_concurrent_agents":3,"max_executions":20,"source_scope":"project","allow_intent_questions":true}})).unwrap();
            assert_eq!(run["status"], "exploring", "{step}");
            assert!(get(&db, "jobs", &format!("job:{rid}:planner")).is_err());
            for task in plan["tasks"].as_array().unwrap() {
                let job = get(
                    &db,
                    "jobs",
                    &format!("job:{rid}:task:{}", task["id"].as_str().unwrap()),
                )
                .unwrap();
                assert_eq!(
                    job["payload"]["execution"]["model"], "gpt-5.6-luna",
                    "{step}"
                );
            }
            let integrator = &run["agents"][plan["integrator_agent"].as_u64().unwrap() as usize];
            assert_eq!(integrator["model"], "glm-5.3-flash");
        }
    }
}
