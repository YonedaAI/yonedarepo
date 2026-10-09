use crate::process::Result;
use serde_json::Value;
use std::path::Path;
pub(super) fn write(directory: &Path, manifest: &Value, results: &[Value]) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    std::fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec_pretty(manifest)?,
    )?;
    std::fs::write(
        directory.join("results.json"),
        serde_json::to_vec_pretty(results)?,
    )?;
    let mut report = String::from(
        "# Context usefulness pilot\n\nThis is a limited synthetic pilot. Agent explanations are assertions; server receipts prove delivery; sandbox checks test exact captured source. The source-only and flat-notes conditions are intentionally prevented from retrieving graph history. No population-level conclusion follows from this sample.\n\n| Case | Condition | Repetition | Completed / executions | Behavioral passes / checked | Recorded reads |\n|---|---|---:|---:|---:|---:|\n",
    );
    for result in results {
        let observed = result["evidence"]["observations"].as_array();
        let total = observed.map_or(0, Vec::len);
        let passed = observed.map_or(0, |items| {
            items.iter().filter(|i| i["oracle"]["pass"] == true).count()
        });
        let completed = observed.map_or(0, |items| {
            items.iter().filter(|i| i["status"] == "completed").count()
        });
        let checked = observed.map_or(0, |items| {
            items.iter().filter(|i| i["oracle"].is_object()).count()
        });
        report.push_str(&format!(
            "| {} | {} | {} | {completed} / {total} | {passed} / {checked} | {} |\n",
            result["trial"]["case"],
            result["trial"]["arm"],
            result["trial"]["repetition"],
            result["evidence"]["usage_pages"][0]["counts"]["read_calls"]
        ));
    }
    if results.iter().any(|r| r["oracle_recheck"].is_object()) {
        report.push_str("\nRechecked existing captures with context-fixture-v2 without new inference. The privacy check permits anonymous event flags and tests persistence of supplied attendee identity. Original verdicts remain in oracle_previous; input artifacts are preserved. This finite canary is not a general privacy proof.\n");
    }
    report.push_str(&format!("\nObserved {} of 27 planned clusters. Missing trials, setup failures, model failures and timeouts remain in results.json. An unobserved token metric stays null; it is not zero. Platform eligibility checks and the separate behavioral oracle are different evidence. Browser-wiring checks are structural, not browser acceptance.\n\nGraph vs notes compares structured retrieval with identical historical facts; graph vs source-only also measures the availability of historical information. Check the receipts and explicit citations before attributing a pass to context. No favorable outcome is assumed.\n",results.len()));
    std::fs::write(directory.join("report.md"), report)?;
    Ok(())
}

/// Remove known credential values even if an untrusted assertion echoed one.
pub(super) fn redact(value: &mut Value, credentials: &Value) {
    let mut secrets = Vec::new();
    fn collect(value: &Value, secrets: &mut Vec<String>) {
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    if ["key", "password", "token", "recovery_code"].contains(&key.as_str()) {
                        if let Some(text) = value.as_str().filter(|s| !s.is_empty()) {
                            secrets.push(text.into());
                        }
                    } else {
                        collect(value, secrets);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect(item, secrets);
                }
            }
            _ => {}
        }
    }
    fn clean(value: &mut Value, secrets: &[String]) {
        match value {
            Value::String(text) => {
                for secret in secrets {
                    *text = text.replace(secret, "[redacted]");
                }
            }
            Value::Object(fields) => {
                for item in fields.values_mut() {
                    clean(item, secrets);
                }
            }
            Value::Array(items) => {
                for item in items {
                    clean(item, secrets);
                }
            }
            _ => {}
        }
    }
    collect(credentials, &mut secrets);
    clean(value, &secrets);
}
#[cfg(test)]
mod tests {
    #[test]
    fn secrets_are_removed_from_assertions() {
        let credentials = serde_json::json!({"password":"private-password","local_providers":{"mimo":{"key":"private-key"}}});
        let mut value = serde_json::json!({"label":"echo private-key and private-password"});
        super::redact(&mut value, &credentials);
        assert_eq!(value["label"], "echo [redacted] and [redacted]");
    }
}
