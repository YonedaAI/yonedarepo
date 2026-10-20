use super::*;
use serde_json::json;

#[test]
fn reasoning_auto_roundtrip_preserves_old_frozen_pool_and_request_digests() {
    let request = json!({"version":1,"requested_agents":[{"connection":null,"role":"auto"}]});
    let pool = json!([{"connection":"seed","provider":"codex","model":"gpt-5.6-luna"}]);
    let typed: AdaptiveTeam = serde_json::from_value(request.clone()).unwrap();
    let members: Vec<ApprovedModel> = serde_json::from_value(pool.clone()).unwrap();
    assert_eq!(json!(typed), request);
    assert_eq!(json!(members), pool);
    assert_eq!(
        crate::fingerprint(&pool).unwrap(),
        crate::fingerprint(&json!(members)).unwrap()
    );
    let mut changed = pool.clone();
    changed[0]["reasoning_efforts"] = json!(["low", "high"]);
    assert_ne!(
        crate::fingerprint(&pool).unwrap(),
        crate::fingerprint(&changed).unwrap()
    );
}

#[test]
fn reasoning_forged_capabilities_and_unsupported_forced_thinking_toggle_are_rejected() {
    for (provider, model, effort) in [
        ("zai", "glm-5.3-flash", "off"),
        ("claude", "claude-haiku-5-5", "none"),
        ("codex", "gpt-6.1-sol", "none"),
    ] {
        let pool: Vec<ApprovedModel> = serde_json::from_value(json!([{"connection":"profile","provider":provider,"model":model,"reasoning_efforts":[effort]}])).unwrap();
        assert_eq!(validate_pool(&pool).unwrap_err().code, "FORBIDDEN");
    }
}

#[test]
fn reasoning_execution_settings_are_exact_slot_bound_and_legacy_auto_is_unchanged() {
    let agent = json!({"connection":"seed","provider":"codex","model":"gpt-5.6-luna","reasoning_effort":"high"});
    let run = json!({"adaptive_team":{"version":1},"agents":[agent]});
    let mut execution = agent.clone();
    execution["agent_index"] = json!(0);
    assert_eq!(execution_effort(&run, &execution).unwrap(), Some("high"));
    for (field, value) in [
        ("reasoning_effort", json!("max")),
        ("reasoning_effort", Value::Null),
        ("agent_index", json!(1)),
        ("connection", json!("other")),
    ] {
        let mut forged = execution.clone();
        forged[field] = value;
        assert_eq!(execution_effort(&run, &forged).unwrap_err().code, "FENCED");
    }
    assert_eq!(execution_effort(&json!({}), &json!({})).unwrap(), None);
    assert_eq!(
        execution_effort(&json!({}), &execution).unwrap_err().code,
        "FORBIDDEN"
    );
    assert_eq!(execution_effort(&json!({"adaptive_team":{"version":1},"agents":[{"provider":"codex","model":"gpt-5.6-luna"}]}),&json!({"provider":"codex","model":"gpt-5.6-luna"})).unwrap(),None);
}

#[test]
fn reasoning_fixed_run_uses_only_original_explicit_agent_slot_authority() {
    let agent = json!({"connection":"profile","provider":"codex","model":"gpt-5.6-luna","reasoning_effort":"high"});
    let run = json!({"mode":"compare","agents":[agent]});
    let mut execution = agent.clone();
    execution["agent_index"] = json!(0);
    assert_eq!(execution_effort(&run, &execution).unwrap(), Some("high"));
    for (field, value) in [
        ("connection", json!("other")),
        ("model", json!("gpt-6-luna")),
        ("provider", json!("claude")),
        ("agent_index", json!(1)),
        ("reasoning_effort", json!("max")),
        ("reasoning_effort", Value::Null),
    ] {
        let mut forged = execution.clone();
        forged[field] = value;
        assert_eq!(execution_effort(&run, &forged).unwrap_err().code, "FENCED");
    }
    let mut changed = run.clone();
    changed["autonomy_approval"]["agents"] = run["agents"].clone();
    changed["agents"][0]["reasoning_effort"] = json!("max");
    assert_eq!(
        execution_effort(&changed, &execution).unwrap_err().code,
        "FENCED"
    );
    assert_eq!(
        execution_effort(&json!({}), &execution).unwrap_err().code,
        "FORBIDDEN"
    );
}
