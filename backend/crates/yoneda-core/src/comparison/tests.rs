use super::*;
fn run() -> Value {
    let builders = json!([{ "provider":"zai","model":"glm-5.3-flash","connection":"glm","reasoning_effort":"high" },{ "provider":"codex","model":"gpt-6-sol","connection":"codex" }]);
    let reviewer = json!({"provider":"zai","model":"glm-5.3-flash","connection":"glm"});
    let mut run = json!({"id":"compare","agents":builders,"intent":"Safe booking","criteria":[],"policy":{"version":"v1"},"context":[],"base":{"repository":"test/source","commit":"a".repeat(40)},"model_budgets":[]});
    let mut a = json!({"id":"approval","version":1,"builders":builders,"reviewer":reviewer,"intent":run["intent"],"criteria":run["criteria"],"policy":run["policy"],"context":run["context"],"base":run["base"],"max_review_requests":12,"max_repair_rounds":2,"max_logical_executions":7,"budget_scope":"run","model_budget_configs":[]});
    a["digest"] = json!(crate::fingerprint(&a).unwrap());
    run["comparison"] = json!({"approval":a});
    run
}
#[test]
fn automatic_reviewer_does_not_inherit_high_builder_effort_and_rejects_identity_forgery() {
    let run = run();
    let e = json!({"run_id":"compare","comparison_approval_id":"approval","comparison_role":"reviewer","role":"reviewer","provider":"zai","model":"glm-5.3-flash","connection":"glm"});
    assert_eq!(
        crate::adaptive_team::execution_effort(&run, &e).unwrap(),
        None
    );
    for (key, value) in [
        ("reasoning_effort", json!("max")),
        ("model", json!("glm-5.3")),
        ("agent_index", json!(0)),
        ("comparison_approval_id", json!("other")),
    ] {
        let mut forged = e.clone();
        forged[key] = value;
        assert!(
            crate::adaptive_team::execution_effort(&run, &forged).is_err(),
            "{key}"
        );
    }
    let mut changed = run.clone();
    changed["comparison"]["approval"]["reviewer"]["model"] = json!("glm-5.3");
    assert!(crate::adaptive_team::execution_effort(&changed, &e).is_err());
}
#[test]
fn comparison_repair_cannot_bypass_approval_fence_via_original_fixed_slot() {
    let run = run();
    let e = json!({"run_id":"compare","comparison_approval_id":"wrong","comparison_role":"repair","comparison_round":1,"role":"coding","provider":"zai","model":"glm-5.3-flash","connection":"glm","agent_index":0,"reasoning_effort":"high"});
    assert_eq!(
        crate::adaptive_team::execution_effort(&run, &e)
            .unwrap_err()
            .code,
        "FENCED"
    );
}
