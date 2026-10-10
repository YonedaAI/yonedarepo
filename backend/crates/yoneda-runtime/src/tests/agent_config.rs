use super::*;
use serde_json::json;

#[test]
fn harness_budget_actual_anthropic_and_legacy_claude_keep_one_dollar_allowance() {
    for execution in [
        json!({"harness":"claude","provider":"claude"}),
        json!({"harness":"claude"}),
    ] {
        let args = claude_arguments(&execution, false, "claude-sonnet-4-6");
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--max-budget-usd", "1.00"])
        );
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--model", "claude-sonnet-4-6"])
        );
    }
}

#[test]
fn harness_budget_third_party_models_do_not_use_anthropic_dollar_estimates() {
    for (provider, model) in [("mimo", "mimo-v2.6-flash"), ("zai", "glm-4.7-flash")] {
        let args = claude_arguments(
            &json!({"harness":"claude","provider":provider}),
            false,
            model,
        );
        assert!(!args.contains(&"--max-budget-usd"));
        assert!(args.windows(2).any(|pair| pair == ["--model", model]));
        assert!(args.contains(&"--strict-mcp-config"));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--mcp-config", "/home/agent/mcp.json"])
        );
    }
}

#[test]
fn model_budgets_approved_anthropic_run_uses_owner_allowance_without_hidden_cli_cap() {
    let args = claude_arguments(
        &json!({"harness":"claude","provider":"claude"}),
        true,
        "claude-sonnet-4-6",
    );
    assert!(!args.contains(&"--max-budget-usd"));
    assert!(
        args.windows(2)
            .any(|pair| pair == ["--model", "claude-sonnet-4-6"])
    );
}

#[tokio::test]
async fn model_budgets_runtime_uses_frozen_output_and_execution_limits() {
    let entry = json!({"provider":"mimo","model":"flash","max_requests":40,"max_output_tokens":512,
        "max_execution_ms":60000,"spend_limit_microusd":null,"pricing":null});
    let mut job = json!({"kind":"agent","payload":{"run":{"model_budgets":[entry]},
        "execution":{"provider":"mimo","model":"flash","budget":{"provider":"mimo","model":"flash"}}}});
    let budget = crate::execution_limits::model_budget(&job)
        .unwrap()
        .unwrap();
    assert_eq!(crate::execution_limits::timeout_ms(&job).unwrap(), 50000);
    let mut command = Command::new("/bin/sh");
    untrusted(&mut command, std::path::Path::new("/tmp"));
    configure_output_limit(&mut command, Some(&budget));
    command.args(["-c", "printf '%s' \"$CLAUDE_CODE_MAX_OUTPUT_TOKENS\""]);
    let output = command.output().await.unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(output.stdout).unwrap(), "512");
    job["payload"]["run"]["model_budgets"][0]["max_execution_ms"] = json!(1_800_000);
    assert_eq!(
        crate::execution_limits::timeout_ms(&job).unwrap(),
        1_790_000
    );
    job["payload"]["execution"]["budget"]["model"] = json!("another-model");
    assert_eq!(
        crate::execution_limits::model_budget(&job)
            .unwrap_err()
            .code,
        "FENCED"
    );
    assert_eq!(
        crate::execution_limits::timeout_ms(&json!({"kind":"agent","payload":{}})).unwrap(),
        570000
    );
}

#[test]
fn gemini_turn_budget_uses_approved_request_allowance_and_preserves_legacy_default() {
    let mcp = json!({"mcpServers":{"yonedarepo":{"command":"/usr/local/bin/yoneda-runtime","args":["mcp"]}}});
    let budget: yoneda_core::model_budget::ModelBudget = serde_json::from_value(json!({
        "provider":"gemini","model":"gemini-3.8-flash","max_requests":48,"max_output_tokens":4096,
        "max_execution_ms":600000,"spend_limit_microusd":null,"pricing":null}))
    .unwrap();
    let legacy = gemini_settings("gemini-3.8-flash", &mcp, None);
    let configured = gemini_settings("gemini-3.8-flash", &mcp, Some(&budget));
    assert_eq!(legacy["model"]["maxSessionTurns"], 24);
    assert_eq!(configured["model"]["maxSessionTurns"], 48);
    assert_eq!(configured["model"]["name"], "gemini-3.8-flash");
    assert_eq!(configured["mcp"]["allowed"], json!(["yonedarepo"]));
    assert_eq!(configured["mcpServers"], mcp["mcpServers"]);
    let mut uncapped = budget;
    uncapped.max_requests = None;
    assert_eq!(
        gemini_settings("gemini-3.8-flash", &mcp, Some(&uncapped))["model"]["maxSessionTurns"],
        -1
    );
}
