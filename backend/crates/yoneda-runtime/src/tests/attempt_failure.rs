use super::*;

fn error(code: &str) -> Error {
    Error::new(code, "fixture")
}

#[test]
fn externally_stopped_agent_harness_is_retryable() {
    let stopped = crate::harness_error::failure(
        &serde_json::json!({"exit":143,"stdout":"private"}),
        &serde_json::json!({"digest":"a".repeat(64)}),
    );
    assert_eq!(disposition("agent", &stopped), Disposition::Retry);
    assert!(disposition("agent", &stopped).retryable());
}

#[test]
fn agent_outcomes_and_limits_remain_terminal() {
    for code in [
        "RUNTIME",
        "EXECUTION_TIMEOUT",
        "HARNESS_BUDGET",
        "MODEL_REQUEST_LIMIT",
        "MODEL_SPEND_LIMIT",
        "PROVIDER_AUTH",
        "PROVIDER_BALANCE",
        "PROVIDER_RATE_LIMIT",
        "PROVIDER_UNAVAILABLE",
        "PROVIDER_CONFIGURATION",
        "FENCED",
        "FORBIDDEN",
        "RESOURCE_LIMIT",
        "harness_interrupted",
    ] {
        assert_eq!(
            disposition("agent", &error(code)),
            Disposition::Terminal,
            "{code}"
        );
        assert!(!disposition("agent", &error(code)).retryable());
    }
}

#[test]
fn trusted_job_kinds_keep_their_existing_retry_policy() {
    for kind in ["capture", "evaluate", "publish", "site", ""] {
        for code in ["RUNTIME", "FENCED", INTERRUPTED] {
            assert_eq!(
                disposition(kind, &error(code)),
                Disposition::Retry,
                "{kind} {code}"
            );
        }
    }
}
