//! Translate terminal CLI transport observations into safe, actionable diagnostics.
//! Raw provider responses stay in transcript evidence and never become UI messages.
use serde_json::Value;
use yoneda_core::Error;

const MAX_TERMINAL_LINES: usize = 128;
const MAX_EVENT_BYTES: usize = 64 * 1024;

pub(crate) fn failure(output: &Value, evidence: &Value) -> Error {
    let transcript = evidence["digest"]
        .as_str()
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let evidence_note = match transcript {
        Some(digest) => format!("Transcript evidence {digest}"),
        None => "Transcript evidence identifier unavailable".into(),
    };
    if let Some((code, message)) = terminal_diagnostic(output) {
        return Error::new(code, format!("{message} {evidence_note}"));
    }
    let exit = output["exit"]
        .as_i64()
        .filter(|exit| (-1..=255).contains(exit));
    let exit = exit.map_or_else(|| "unknown".into(), |exit| exit.to_string());
    if let Some(signal) = output["signal"]
        .as_i64()
        .filter(|signal| (1..=64).contains(signal))
    {
        return Error::new(
            "RUNTIME",
            format!("Harness terminated by signal {signal}. {evidence_note}"),
        );
    }
    Error::new("RUNTIME", format!("Harness exited {exit}. {evidence_note}"))
}

fn terminal_diagnostic(output: &Value) -> Option<(&'static str, &'static str)> {
    if output["exit"].as_i64().is_none_or(|exit| exit == 0) {
        return None;
    }
    // Claude-compatible stream-json has one terminal result. Inspect the last
    // result only: earlier retry observations must not replace the final cause.
    let result = output["stdout"]
        .as_str()?
        .lines()
        .rev()
        .take(MAX_TERMINAL_LINES)
        .filter(|line| line.len() <= MAX_EVENT_BYTES)
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|event| event["type"] == "result")?;
    if result["is_error"] != true {
        return None;
    }
    if result["terminal_reason"] == "budget_exhausted" {
        return Some((
            "HARNESS_BUDGET",
            "The agent harness reached its configured spending allowance. Review provider spend and run limits before starting a new run.",
        ));
    }
    if result["terminal_reason"] != "api_error" {
        return None;
    }
    if result["api_error_status"] == 409 {
        let body = result["result"].as_str()?.strip_prefix("API Error: 409 ")?;
        return proxy_diagnostic(body);
    }
    diagnostic(result["api_error_status"].as_u64()?)
}

fn proxy_diagnostic(body: &str) -> Option<(&'static str, &'static str)> {
    // Some Claude-compatible SDKs replace the JSON error with its message.
    // Match our complete Worker messages, never infer a cause from arbitrary text.
    let code = match body {
        "This is a Token Plan key. Select Token Plan and its region."
        | "Token Plan requires its dedicated tp- or ttp- key" => "PROVIDER_CONFIGURATION",
        "This provider/model group exhausted its approved request budget" => "MODEL_REQUEST_LIMIT",
        "This provider/model group has insufficient approved spend remaining for the conservative request ceiling" => {
            "MODEL_SPEND_LIMIT"
        }
        _ => {
            let error: Value = serde_json::from_str(body.trim()).ok()?;
            match error["error"]["code"].as_str()? {
                "MODEL_REQUEST_LIMIT" => "MODEL_REQUEST_LIMIT",
                "MODEL_SPEND_LIMIT" => "MODEL_SPEND_LIMIT",
                "PROVIDER_CONFIGURATION" => "PROVIDER_CONFIGURATION",
                _ => return None,
            }
        }
    };
    match code {
        "PROVIDER_CONFIGURATION" => Some((
            "PROVIDER_CONFIGURATION",
            "The saved provider connection has incompatible key and billing settings. Edit its billing source and region before restarting.",
        )),
        "MODEL_REQUEST_LIMIT" => Some((
            "MODEL_REQUEST_LIMIT",
            "This provider/model group reached its owner-approved request allowance. Review the run budget before approving a new run.",
        )),
        "MODEL_SPEND_LIMIT" => Some((
            "MODEL_SPEND_LIMIT",
            "This provider/model group has insufficient approved spend remaining for the next request. Review its usage and budget before approving a new run.",
        )),
        _ => None,
    }
}

fn diagnostic(status: u64) -> Option<(&'static str, &'static str)> {
    Some(match status {
        400 | 422 => (
            "PROVIDER_REQUEST",
            "The model provider rejected the request. Check that the configured model and API endpoint are compatible.",
        ),
        401 => (
            "PROVIDER_AUTH",
            "The model provider rejected its API key (HTTP 401). Update the provider connection, then start a new run.",
        ),
        402 => (
            "PROVIDER_BALANCE",
            "The model provider reports insufficient account balance or billing (HTTP 402). Add provider credits or choose another funded connection, then start a new run.",
        ),
        403 => (
            "PROVIDER_FORBIDDEN",
            "The model provider denied access (HTTP 403). Check that this connection is allowed to use the configured model.",
        ),
        404 => (
            "PROVIDER_MODEL",
            "The model provider could not find the configured model or API endpoint (HTTP 404). Check the provider connection settings.",
        ),
        413 => (
            "PROVIDER_REQUEST_LIMIT",
            "The model provider rejected the request size (HTTP 413). Reduce the task or context before starting a new run.",
        ),
        429 => (
            "PROVIDER_RATE_LIMIT",
            "The provider rate limit or quota was reached (HTTP 429). Wait or check provider quota before starting a new run.",
        ),
        500..=599 => (
            "PROVIDER_UNAVAILABLE",
            "The model provider is temporarily unavailable (HTTP 5xx). Try a new run when the provider recovers.",
        ),
        _ => return None,
    })
}

#[cfg(test)]
#[path = "tests/harness_error.rs"]
mod tests;
