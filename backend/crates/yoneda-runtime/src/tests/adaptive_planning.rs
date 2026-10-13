use super::*;
#[test]
fn adaptive_planner_sees_approved_pool_and_requested_roles_without_new_model_authority() {
    let payload = json!({"execution":{"provider":"codex","model":"gpt-5.6-luna","budget":{"provider":"codex","model":"gpt-5.6-luna"}},"run":{"agents":[{"connection":"seed","provider":"codex","model":"gpt-5.6-luna","role_hint":"frontend"}],"approved_model_pool":[{"connection":"seed","provider":"codex","model":"gpt-5.6-luna"},{"connection":"cheap","provider":"zai","model":"glm-5.3-flash"}],"adaptive_team":{"version":1,"requested_agents":[{"connection":"seed","role":"frontend"}]},"model_budgets":[{"provider":"codex","model":"gpt-5.6-luna","max_requests":144,"max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":50000000,"pricing":{"input_microusd_per_million":250000,"output_microusd_per_million":1200000,"source":"owner-approved conservative rates"}}]},"policy":{"build":{}}});
    let text = prompt(&payload).unwrap();
    assert!(text.contains("approved connected-model pool"));
    assert!(text.contains("glm-5.3-flash"));
    assert!(text.contains("requested roles"));
    assert!(text.contains("\"role_hint\":\"frontend\""));
    assert!(text.contains("\"connection\":\"seed\",\"role\":\"frontend\""));
    assert!(text.contains("connection,role"));
    assert!(text.contains("144"));
    assert!(!text.contains("Do not add agents, change models"));
}
