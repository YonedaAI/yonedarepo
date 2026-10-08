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
pub fn cases() -> Vec<Case> {
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
    let build = report["build"]["exit"] == 0;
    let observed = report["cases"].as_array();
    let cases = cases();
    let passed = build
        && observed.is_some_and(|v| {
            v.len() == cases.len()
                && v.iter().zip(&cases).all(|(actual, case)| {
                    actual["exit"] == 0
                        && actual["input"] == serde_json::to_value(case).unwrap()
                        && actual["actual"] == expected(case)
                })
        });
    vec![super::Check{name:"build".into(),status:if build {"pass"}else{"fail"}.into(),detail:"Clean offline build of captured revision".into()},
         super::Check{name:"behavior".into(),status:if passed {"pass"}else{"fail"}.into(),detail:"External oracle checked safe methods, transient statuses, exponential backoff, bounded attempts and total deadline".into()}]
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
}
