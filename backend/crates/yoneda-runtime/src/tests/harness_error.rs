use super::*;
use serde_json::json;

fn output(status: u64, raw_message: &str) -> Value {
    let event = json!({"type":"result","is_error":true,"terminal_reason":"api_error",
        "api_error_status":status,"result":raw_message});
    json!({"exit":1,"stderr":"Bearer private-stderr-token","stdout":format!("{}\n{event}\n",json!({"type":"assistant","message":{"content":"Private model content"}}))})
}
fn evidence() -> Value {
    json!({"digest":"a".repeat(64)})
}

#[test]
fn signal_evidence_is_distinct_from_shell_exit_143_and_not_a_provider_diagnosis() {
    let signal = failure(
        &json!({"exit":-1,"signal":15,"stdout":"private raw text"}),
        &evidence(),
    );
    assert!(signal.message.contains("signal 15"));
    assert_eq!(signal.code, "RUNTIME");
    let exit = failure(
        &json!({"exit":143,"signal":null,"stdout":"private raw text"}),
        &evidence(),
    );
    assert!(exit.message.contains("exited 143"));
    assert!(!exit.message.contains("signal"));
    assert!(!exit.message.contains("private"));
}

#[test]
fn provider_error_402_reports_billing_cause_and_keeps_transcript_without_raw_text() {
    let error = failure(
        &output(
            402,
            "API Error: 402 Insufficient account balance; Authorization: Bearer secret-fixture",
        ),
        &evidence(),
    );
    assert_eq!(error.code, "PROVIDER_BALANCE");
    assert!(error.message.contains("insufficient account balance"));
    assert!(error.message.contains("HTTP 402"));
    assert!(error.message.contains(&"a".repeat(64)));
    assert!(!error.message.contains("secret-fixture"));
    assert!(!error.message.contains("private-stderr-token"));
    assert!(!error.message.contains("Private model content"));
}

#[test]
fn provider_error_known_statuses_map_to_static_diagnostics() {
    for (status, code) in [
        (400, "PROVIDER_REQUEST"),
        (401, "PROVIDER_AUTH"),
        (403, "PROVIDER_FORBIDDEN"),
        (404, "PROVIDER_MODEL"),
        (413, "PROVIDER_REQUEST_LIMIT"),
        (422, "PROVIDER_REQUEST"),
        (429, "PROVIDER_RATE_LIMIT"),
        (503, "PROVIDER_UNAVAILABLE"),
    ] {
        let error = failure(
            &output(status, "private raw provider response"),
            &evidence(),
        );
        assert_eq!(error.code, code);
        assert!(!error.message.contains("private raw provider response"));
    }
}

#[test]
fn provider_error_unknown_malformed_or_model_authored_output_uses_safe_fallback() {
    let misleading = json!({"type":"assistant","message":{"type":"result","is_error":true,
        "terminal_reason":"api_error","api_error_status":402}});
    let non_api = json!({"type":"result","is_error":true,"terminal_reason":"model_error",
        "api_error_status":402,"result":"private raw content"});
    let mut oversized = "x".repeat(MAX_EVENT_BYTES + 1);
    oversized.push_str("private oversized content");
    for stdout in [
        "API Error: 402 Bearer private-text".into(),
        "{broken private-json".into(),
        misleading.to_string(),
        non_api.to_string(),
        oversized,
        output(799, "private unknown status")["stdout"]
            .as_str()
            .unwrap()
            .to_owned(),
    ] {
        let error = failure(
            &json!({"exit":1,"stdout":stdout,"stderr":"private stderr"}),
            &evidence(),
        );
        assert_eq!(error.code, "RUNTIME");
        assert_eq!(
            error.message,
            format!("Harness exited 1. Transcript evidence {}", "a".repeat(64))
        );
    }
}

#[test]
fn provider_error_final_result_overrides_earlier_error_and_identifiers_are_sanitized() {
    let early = output(402, "private previous error")["stdout"]
        .as_str()
        .unwrap()
        .to_owned();
    let stdout = format!(
        "{early}{}\n",
        json!({"type":"result","is_error":true,"terminal_reason":"max_turns"})
    );
    assert_eq!(
        failure(&json!({"exit":1,"stdout":stdout}), &evidence()).code,
        "RUNTIME"
    );
    let safe = failure(
        &json!({"exit":"private exit","stdout":"private raw text"}),
        &json!({"digest":"Bearer private-digest"}),
    );
    assert_eq!(
        safe.message,
        "Harness exited unknown. Transcript evidence identifier unavailable"
    );
}

#[test]
fn harness_budget_terminal_result_reports_allowance_without_using_provider_raw_text() {
    let result = json!({"type":"result","subtype":"error_max_budget_usd","is_error":true,
        "terminal_reason":"budget_exhausted","api_error_status":null,"num_turns":34,
        "total_cost_usd":1.13681,"result":"private terminal text"});
    let error = failure(
        &json!({"exit":1,"stdout":format!("{result}\n"),
        "stderr":"private unrecognized model details"}),
        &evidence(),
    );
    assert_eq!(error.code, "HARNESS_BUDGET");
    assert!(error.message.contains("configured spending allowance"));
    assert!(error.message.contains(&"a".repeat(64)));
    assert!(!error.message.contains("private"));
    assert!(!error.message.contains("1.13681"));
}

#[test]
fn model_budgets_proxy_errors_use_only_known_codes_in_terminal_api_envelopes() {
    for code in ["MODEL_REQUEST_LIMIT", "MODEL_SPEND_LIMIT"] {
        let body = json!({"error":{"code":code,"message":"Bearer private-provider-token"}});
        let error = failure(&output(409, &format!("API Error: 409 {body}")), &evidence());
        assert_eq!(error.code, code);
        assert!(!error.message.contains("private-provider-token"));
    }
    for message in [
        "MODEL_SPEND_LIMIT private-text",
        "API Error: 409 {broken private-json}",
        "API Error: 409 {\"error\":{\"code\":\"INVENTED_CODE\",\"message\":\"private\"}}",
    ] {
        let error = failure(&output(409, message), &evidence());
        assert_eq!(error.code, "RUNTIME");
        assert!(!error.message.contains("private"));
    }
}

#[test]
fn model_budgets_stripped_worker_envelopes_preserve_only_exact_allowlisted_causes() {
    for (code, message) in [
        (
            "MODEL_REQUEST_LIMIT",
            "This provider/model group exhausted its approved request budget",
        ),
        (
            "MODEL_SPEND_LIMIT",
            "This provider/model group has insufficient approved spend remaining for the conservative request ceiling",
        ),
    ] {
        let raw = format!("API Error: 409 {message}");
        let error = failure(&output(409, &raw), &evidence());
        assert_eq!(error.code, code);
        assert!(error.message.contains(&"a".repeat(64)));
        assert!(!error.message.contains("private-stderr-token"));
        for altered in [
            format!("{raw}; Bearer private-token"),
            format!("API Error: 409 prefix {message}"),
            format!("API Error: 409 {message}."),
            format!("MODEL_REQUEST_LIMIT {message}"),
        ] {
            let safe = failure(&output(409, &altered), &evidence());
            assert_eq!(safe.code, "RUNTIME");
            assert!(!safe.message.contains("private-token"));
        }
        let wrong_status = failure(&output(400, &raw), &evidence());
        assert_ne!(wrong_status.code, code);
    }
}

#[test]
fn legacy_token_plan_configuration_failure_is_actionable_without_raw_provider_text() {
    let raw = "API Error: 409 This is a Token Plan key. Select Token Plan and its region.";
    let error = failure(&output(409, raw), &evidence());
    assert_eq!(error.code, "PROVIDER_CONFIGURATION");
    assert!(error.message.contains("connection"));
    assert_eq!(
        failure(&output(409, &format!("{raw} private-token")), &evidence()).code,
        "RUNTIME"
    );
}
