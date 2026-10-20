use super::*;
use serde_json::json;

fn pool() -> Vec<ApprovedModel> {
    serde_json::from_value(json!([
        {"connection":"glm","provider":"zai","model":"glm-5.3-flash"},
        {"connection":"codex","provider":"codex","model":"gpt-5.6-luna"}
    ]))
    .unwrap()
}

#[test]
fn specialist_connection_must_be_an_approved_pool_member() {
    let request = json!({"version":1,"requested_agents":[{"connection":null,"role":"backend"}],"specialist_connection":"codex"});
    let typed: AdaptiveTeam = serde_json::from_value(request.clone()).unwrap();
    typed.validate(&pool()).unwrap();
    assert_eq!(json!(typed), request);
    let mut outside = typed.clone();
    outside.specialist_connection = Some("sonnet".into());
    assert_eq!(outside.validate(&pool()).unwrap_err().code, "FORBIDDEN");
}

#[test]
fn requests_without_a_specialist_keep_their_frozen_shape() {
    let request = json!({"version":1,"requested_agents":[{"connection":null,"role":"auto"}]});
    let typed: AdaptiveTeam = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(typed.specialist_connection, None);
    assert_eq!(json!(typed), request);
}
