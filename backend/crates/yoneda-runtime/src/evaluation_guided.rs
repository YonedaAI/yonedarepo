//! Compact server-frozen guided oracle context; candidate environments have no authority.
use serde_json::Value;
use yoneda_core::Result;
pub(super) fn validate(job: &Value) -> Result<Option<Value>> {
    let Some(binding) = job["payload"].get("guided") else {
        return Ok(None);
    };
    let invalid = || {
        yoneda_core::Error::new(
            "GUIDED_BINDING",
            "Malformed server-frozen guided check binding",
        )
    };
    let fields = [
        "session_id",
        "profile_id",
        "version",
        "step_id",
        "check_phase",
        "variant",
    ];
    let object = binding.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| !fields.contains(&key.as_str()))
        || binding["version"] != 1
        || binding["profile_id"] != "task-board-v1"
        || binding["session_id"].as_str().is_none_or(|id| {
            !id.strip_prefix("guide-session:").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 120
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            })
        })
    {
        return Err(invalid());
    }
    let phase = binding["check_phase"].as_str().ok_or_else(invalid)?;
    let step = binding["step_id"].as_str().ok_or_else(invalid)?;
    if !matches!(
        (step, phase),
        ("build", "build") | ("extend", "extend") | ("concurrent", "parallel" | "final")
    ) {
        return Err(invalid());
    }
    let variant = binding["variant"].as_str();
    if (phase == "parallel" && !matches!(variant, Some("filter" | "sort")))
        || (phase != "parallel" && binding.get("variant").is_some())
    {
        return Err(invalid());
    }
    Ok(Some(binding.clone()))
}
pub(super) fn record(report: &mut Value, guide: Option<&Value>) {
    if let Some(guide) = guide {
        report["guided_check_phase"] = guide["check_phase"].clone();
        report["guided_check_variant"] = guide["variant"].clone();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn binding(step: &str, phase: &str, variant: Option<&str>) -> Value {
        let mut binding = json!({"session_id":"guide-session:test","profile_id":"task-board-v1","version":1,"step_id":step,"check_phase":phase});
        if let Some(variant) = variant {
            binding["variant"] = json!(variant);
        }
        json!({"payload":{"guided":binding}})
    }
    #[test]
    fn frozen_guided_bindings_preserve_phase_and_each_parallel_variant() {
        for (step, phase, variant) in [
            ("build", "build", None),
            ("extend", "extend", None),
            ("concurrent", "parallel", Some("filter")),
            ("concurrent", "parallel", Some("sort")),
            ("concurrent", "final", None),
        ] {
            let job = binding(step, phase, variant);
            assert_eq!(
                validate(&job).unwrap(),
                Some(job["payload"]["guided"].clone())
            );
        }
    }
    #[test]
    fn malformed_or_missing_parallel_variant_cannot_guess_an_oracle_phase() {
        for job in [
            binding("build", "final", None),
            binding("concurrent", "parallel", None),
            binding("concurrent", "parallel", Some("future")),
            binding("concurrent", "final", Some("filter")),
            json!({"payload":{"guided":{"session_id":"guided-session","profile_id":"task-board-v1","version":1,"step_id":"build","check_phase":"build"}}}),
            json!({"payload":{"guided":null}}),
            json!({"payload":{"guided":{"profile_id":"forged","version":1,"step_id":"build","check_phase":"build"}}}),
        ] {
            assert!(validate(&job).is_err());
        }
    }
    #[test]
    fn absent_legacy_binding_ignores_candidate_phase_claims() {
        assert_eq!(validate(&json!({"payload":{"candidate":{"guided":{"check_phase":"final"}},"env":{"GUIDED_CHECK_PHASE":"final"}}})).unwrap(),None);
    }
}
