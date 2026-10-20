//! The fixed guide v2 plans pass the same validator as planner output.
use super::*;
use crate::adaptive_team::AgentRole;
use serde_json::Value;

const PLANS: &str = include_str!("../guided_plans.json");

#[test]
fn fixed_guided_plans_validate_with_one_specialist_slot_per_task_and_a_separate_integrator() {
    let data: Value = serde_json::from_str(PLANS).unwrap();
    assert_eq!(data["version"], 2);
    for (step, runs) in [("build", 1), ("extend", 1), ("concurrent", 2)] {
        let entries = data["steps"][step].as_array().unwrap();
        assert_eq!(entries.len(), runs, "{step}");
        for entry in entries {
            let roles: Vec<AgentRole> = serde_json::from_value(entry["roles"].clone()).unwrap();
            let plan: TeamPlan = serde_json::from_value(entry["plan"].clone()).unwrap();
            plan.validate(roles.len()).unwrap();
            assert!(plan.tasks.iter().all(|t| t.agent != plan.integrator_agent));
            for slot in (0..roles.len()).filter(|s| *s != plan.integrator_agent) {
                assert!(plan.tasks.iter().any(|t| t.agent == slot), "{step}");
            }
            assert!(plan.tasks.iter().all(|t| t.depends_on.is_empty()));
        }
    }
    assert_eq!(
        data["steps"]["build"][0]["plan"]["tasks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn fixed_guided_model_mix_names_priced_automatic_models() {
    let data: Value = serde_json::from_str(PLANS).unwrap();
    for group in ["specialists", "coordination"] {
        let entry = &data["model_mix"][group];
        let provider = crate::providers::provider(entry["provider"].as_str().unwrap()).unwrap();
        let model = provider
            .models
            .iter()
            .find(|m| m.id == entry["model"].as_str().unwrap())
            .unwrap();
        assert!(model.auto_seed_eligible && model.conservative_pricing.is_some());
    }
    assert_eq!(data["model_mix"]["specialists"]["model"], "gpt-5.6-luna");
    assert_eq!(data["model_mix"]["coordination"]["model"], "glm-5.3-flash");
}
