//! A model check's answer → a check outcome, failing closed. Only a well-formed answer
//! from the catalog model passes or fails a commit; anything else (an HTTP error, a
//! timeout, malformed JSON) is retried once and then becomes an `error` run, which records
//! no result, so the required check stays missing and landing stays blocked.
use crate::platform_model_check::{ModelSpec, model_spec};
use crate::storage::{bad, string};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use yoneda_core::Result;

/// One retry after the first call.
pub const MAX_ATTEMPTS: usize = 2;
/// Evidence stays well inside the 16 KiB a check result may carry.
const EVIDENCE_BYTES: usize = 12 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Answer {
    verdict: Verdict,
    score: u8,
    findings: Vec<Finding>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Verdict {
    Pass,
    Fail,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Finding {
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    line: Option<u32>,
    severity: Severity,
    message: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Severity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// `model_check_verdict {review, attempts: [{http_status, body, error, duration_ms}]}` →
/// `{outcome: pass|fail|retry|error, evidence}`. The latest attempt decides.
pub fn verdict(c: &Value) -> Result<Value> {
    let review = &c["review"];
    let spec = model_spec(&string(review, "model")?)?;
    let attempts = c["attempts"]
        .as_array()
        .filter(|a| (1..=MAX_ATTEMPTS).contains(&a.len()))
        .ok_or_else(|| bad("Attempts are 1-2 model calls"))?;
    let (input, output) = attempts.iter().fold((0u64, 0u64), |(i, o), a| {
        let usage = &a["body"]["usage"];
        (
            i + usage["input_tokens"].as_u64().unwrap_or(0),
            o + usage["output_tokens"].as_u64().unwrap_or(0),
        )
    });
    let mut evidence = json!({
        "kind": "model", "check": review["name"], "model": spec.id,
        "prompt_version": review["prompt_version"], "base": review["base"],
        "files": review["files"], "diff_chars": review["diff_chars"],
        "diff_budget": review["diff_budget"], "truncated": review["truncated"],
        "attempts": attempts.len(),
        "duration_ms": attempts.iter().filter_map(|a| a["duration_ms"].as_u64()).sum::<u64>(),
        "input_tokens": input, "output_tokens": output,
        "cost_microusd": cost(spec, input, output), "pricing_basis": spec.pricing_basis,
    });
    let latest = attempts.last().unwrap_or(&Value::Null);
    let answer = match parse(latest) {
        Ok(answer) => answer,
        Err(error) => {
            let outcome = if attempts.len() < MAX_ATTEMPTS {
                "retry"
            } else {
                "error"
            };
            evidence["code"] = json!("MODEL_CHECK_ERROR");
            evidence["error"] = json!(error);
            evidence["errors"] = json!(
                attempts
                    .iter()
                    .map(|a| parse(a).err().unwrap_or_default())
                    .collect::<Vec<_>>()
            );
            return Ok(json!({ "outcome": outcome, "evidence": evidence }));
        }
    };
    // A pass that reports a critical finding contradicts itself: fail closed.
    let critical = answer
        .findings
        .iter()
        .any(|f| f.severity == Severity::Critical);
    let failed = answer.verdict == Verdict::Fail || critical;
    if answer.verdict == Verdict::Pass && critical {
        evidence["overridden"] = json!("pass with a critical finding recorded as fail");
    }
    evidence["verdict"] = json!(answer.verdict);
    evidence["score"] = json!(answer.score);
    let findings: Vec<Value> = answer
        .findings
        .into_iter()
        .map(|mut f| {
            f.path = clip(&f.path, 512);
            f.message = clip(&f.message, 500);
            json!(f)
        })
        .collect();
    fit_findings(&mut evidence, findings);
    let outcome = if failed { "fail" } else { "pass" };
    Ok(json!({ "outcome": outcome, "evidence": evidence }))
}

/// Evidence for a check that failed without a model call (the diff is over budget).
pub fn skipped(review: &Value, finding: Value) -> Value {
    let mut evidence = json!({
        "kind": "model", "check": review["name"], "model": review["model"],
        "prompt_version": review["prompt_version"], "base": review["base"],
        "files": review["files"], "diff_chars": review["diff_chars"],
        "diff_budget": review["diff_budget"], "truncated": true,
        "omitted_files": review["omitted_files"], "attempts": 0,
        "input_tokens": 0, "output_tokens": 0, "cost_microusd": 0, "verdict": "fail", "score": 0,
    });
    fit_findings(&mut evidence, vec![finding]);
    evidence
}

/// Adds findings in order while the evidence stays under budget; counts the rest.
fn fit_findings(evidence: &mut Value, findings: Vec<Value>) {
    let total = findings.len();
    evidence["findings"] = json!([]);
    for finding in findings {
        let size = evidence.to_string().len() + finding.to_string().len() + 64;
        if size > EVIDENCE_BYTES {
            break;
        }
        if let Some(list) = evidence["findings"].as_array_mut() {
            list.push(finding);
        }
    }
    let kept = evidence["findings"].as_array().map_or(0, Vec::len);
    if kept < total {
        evidence["findings_omitted"] = json!(total - kept);
    }
}

fn cost(spec: &ModelSpec, input: u64, output: u64) -> u64 {
    let micros = u128::from(input) * u128::from(spec.input_microusd_per_million)
        + u128::from(output) * u128::from(spec.output_microusd_per_million);
    u64::try_from(micros.div_ceil(1_000_000)).unwrap_or(u64::MAX)
}

fn clip(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

/// One attempt's answer, or why it is unusable (bounded, for evidence).
fn parse(attempt: &Value) -> std::result::Result<Answer, String> {
    if let Some(error) = attempt["error"].as_str() {
        return Err(clip(error, 200));
    }
    let status = attempt["http_status"].as_u64().unwrap_or(0);
    let body = &attempt["body"];
    if !(200..300).contains(&status) {
        let detail = body["error"]["message"].as_str().unwrap_or_default();
        return Err(clip(
            &format!("model endpoint answered HTTP {status} {detail}"),
            200,
        ));
    }
    let text: String = body["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect();
    let trimmed = text.trim();
    // Tolerate a code fence around the object; the object itself must be exact.
    let inner = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|rest| rest.strip_suffix("```"))
        .map_or(trimmed, str::trim);
    if inner.is_empty() {
        return Err("model answered with no text".to_owned());
    }
    let answer: Answer = serde_json::from_str(inner)
        .map_err(|e| clip(&format!("model answer is not the required JSON: {e}"), 200))?;
    if answer.score > 100 {
        return Err("model score is outside 0-100".to_owned());
    }
    Ok(answer)
}
