use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Case {
    pub method: String,
    pub statuses: Vec<u16>,
    pub latency: u32,
    pub budget: u32,
    pub max_attempts: u32,
}
fn legacy_cases() -> Vec<Case> {
    vec![
        Case {
            method: "GET".into(),
            statuses: vec![503, 200],
            latency: 20,
            budget: 200,
            max_attempts: 3,
        },
        Case {
            method: "POST".into(),
            statuses: vec![503, 200],
            latency: 20,
            budget: 200,
            max_attempts: 3,
        },
        Case {
            method: "GET".into(),
            statuses: vec![400, 200],
            latency: 20,
            budget: 200,
            max_attempts: 3,
        },
        Case {
            method: "GET".into(),
            statuses: vec![503, 503, 200],
            latency: 60,
            budget: 100,
            max_attempts: 3,
        },
        Case {
            method: "GET".into(),
            statuses: vec![429, 200],
            latency: 10,
            budget: 100,
            max_attempts: 0,
        },
    ]
}
/// Versioned immutable contracts. Keep v1 readable for historical evidence.
pub fn cases_for_suite(suite: &str) -> super::Result<Vec<Case>> {
    let mut cases = legacy_cases();
    match suite {
        "retry-contract-v1" => return Ok(cases),
        "retry-contract-v2" => {}
        _ => {
            return Err(super::Error::new(
                "UNKNOWN_SUITE",
                "Evaluator does not implement this suite",
            ));
        }
    }
    for (method, statuses, latency, budget, max_attempts) in [
        ("GET", vec![503, 503, 200], 10, 200, 3),
        ("GET", vec![429, 200], 10, 100, 3),
        ("GET", vec![503, 200], 10, 30, 2),
        ("GET", vec![503, 200], 10, 29, 2),
        ("GET", vec![503], 1, 100_000, 100),
        ("GET", vec![503], 0, 0, 10),
        ("PUT", vec![503, 200], 10, 100, 3),
        ("DELETE", vec![429, 200], 10, 100, 3),
        ("GET", vec![200, 503], 10, 100, 3),
    ] {
        cases.push(Case {
            method: method.into(),
            statuses,
            latency,
            budget,
            max_attempts,
        });
    }
    Ok(cases)
}
pub fn cases() -> Vec<Case> {
    cases_for_suite("retry-contract-v2").unwrap_or_default()
}
pub fn expected(case: &Case) -> Value {
    let mut elapsed = 0u32;
    let mut attempts = 0u32;
    let mut status = 0u16;
    for index in 0..case.max_attempts.clamp(1, 10) {
        let backoff = if index == 0 {
            0
        } else {
            10u32.saturating_mul(1u32 << ((index - 1).min(8)))
        };
        if attempts > 0
            && elapsed.saturating_add(backoff).saturating_add(case.latency) > case.budget
        {
            break;
        }
        elapsed = elapsed.saturating_add(backoff).saturating_add(case.latency);
        attempts += 1;
        status = *case
            .statuses
            .get(index as usize)
            .unwrap_or_else(|| case.statuses.last().unwrap_or(&200));
        if case.method != "GET" || !(status == 429 || status >= 500) {
            break;
        }
    }
    json!({"attempts":attempts,"elapsed_ms":elapsed,"status":status})
}
pub fn checks(report: &Value) -> Vec<super::Check> {
    checks_for_suite("retry-contract-v2", report).unwrap_or_default()
}
pub fn checks_for_suite(suite: &str, report: &Value) -> super::Result<Vec<super::Check>> {
    let build = report["build"]["exit"] == 0;
    let observed = report["cases"].as_array();
    let cases = cases_for_suite(suite)?;
    let passed = build
        && observed.is_some_and(|v| {
            v.len() == cases.len()
                && v.iter().zip(&cases).all(|(actual, case)| {
                    actual["exit"] == 0
                        && actual["input"] == serde_json::to_value(case).unwrap()
                        && actual["actual"] == expected(case)
                })
        });
    Ok(vec![super::Check{name:"build".into(),status:if build {"pass"}else{"fail"}.into(),detail:"Clean offline build of captured revision".into()},
         super::Check{name:"behavior".into(),status:if passed {"pass"}else{"fail"}.into(),detail:"External oracle checked safe methods, transient statuses, exponential backoff, bounded attempts and total deadline".into()}])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_oracle_enforces_safety_and_total_deadline() {
        let c = cases();
        assert_eq!(
            expected(&c[0]),
            json!({"attempts":2,"elapsed_ms":50,"status":200})
        );
        assert_eq!(
            expected(&c[1]),
            json!({"attempts":1,"elapsed_ms":20,"status":503})
        );
        assert_eq!(
            expected(&c[2]),
            json!({"attempts":1,"elapsed_ms":20,"status":400})
        );
        assert_eq!(
            expected(&c[3]),
            json!({"attempts":1,"elapsed_ms":60,"status":503})
        );
        assert_eq!(
            expected(&c[4]),
            json!({"attempts":1,"elapsed_ms":10,"status":429})
        );
    }
    #[test]
    fn external_verdict_rejects_forged_or_incomplete_test_reports() {
        let report = json!({"build":{"exit":0},"cases":cases().iter().map(|c|json!({"input":c,"exit":0,"actual":expected(c)})).collect::<Vec<_>>()});
        assert!(
            checks(&report)
                .iter()
                .any(|c| c.name == "behavior" && c.status == "pass")
        );
        let mut forged = report.clone();
        forged["cases"][0]["actual"]["attempts"] = json!(99);
        assert!(
            checks(&forged)
                .iter()
                .any(|c| c.name == "behavior" && c.status == "fail")
        );
        let missing = json!({"build":{"exit":0},"cases":[]});
        assert!(
            checks(&missing)
                .iter()
                .any(|c| c.name == "behavior" && c.status == "fail")
        );
    }
    #[test]
    fn suite_rejects_constant_backoff_and_missing_429_retry() {
        let broken_reports: Vec<_> = cases().iter().map(|c| {
            let mut attempts = 0u32;
            let mut elapsed = 0u32;
            let status = loop {
                attempts += 1;
                elapsed += c.latency;
                let status = *c.statuses.get((attempts - 1) as usize).unwrap_or(c.statuses.last().unwrap());
                if c.method != "GET" || status < 500 || attempts >= c.max_attempts.clamp(1, 10) || elapsed + 10 + c.latency > c.budget {
                    break status;
                }
                elapsed += 10;
            }
            ;json!({"input":c,"exit":0,"actual":{"attempts":attempts,"elapsed_ms":elapsed,"status":status}})
        }).collect();
        let report = json!({"build":{"exit":0},"cases":broken_reports});
        assert!(
            checks(&report)
                .iter()
                .any(|c| c.name == "behavior" && c.status == "fail")
        );
    }
}
