//! Independent evaluator oracle from trusted captured Git path metadata, never model claims.
use serde_json::Value;
use yoneda_core::{Result, build::BuildProfile};
pub(crate) fn fields(job: &Value, profile: &BuildProfile, digest: Option<&str>) -> Result<Value> {
    let mut fields = crate::test_bundle::report_fields(profile.test_bundle.as_ref(), digest, job);
    let payload = &job["payload"];
    let candidate = &payload["candidate"];
    let proof = &payload["source_integrity"];
    let object = proof
        .as_object()
        .ok_or_else(|| crate::err("Authoritative source integrity metadata missing"))?;
    let keys = [
        "version",
        "candidate_id",
        "revision",
        "paths_digest",
        "protected_changes",
        "policy_digest",
    ];
    let hex = |value: &Value| {
        value.as_str().is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    };
    if object.len() != keys.len()
        || object.keys().any(|key| !keys.contains(&key.as_str()))
        || proof["version"] != 1
        || proof["candidate_id"] != candidate["id"]
        || !candidate["id"].is_string()
        || proof["revision"] != candidate["revision"]
        || !proof["revision"].is_object()
        || candidate["paths_ref"]["version"] != 1
        || proof["paths_digest"] != candidate["paths_ref"]["digest"]
        || !hex(&proof["paths_digest"])
        || proof["policy_digest"] != yoneda_core::fingerprint(&payload["policy"])?
    {
        return Err(crate::err(
            "Source integrity differs from captured candidate or frozen policy",
        ));
    }
    let protected = profile
        .test_bundle
        .as_ref()
        .map_or(&[][..], |bundle| bundle.protected_paths.as_slice());
    let changes = proof["protected_changes"]
        .as_array()
        .filter(|changes| changes.len() <= protected.len())
        .ok_or_else(|| crate::err("Invalid protected source integrity metadata"))?;
    let mut seen = std::collections::BTreeSet::new();
    for change in changes {
        let change = change
            .as_str()
            .ok_or_else(|| crate::err("Invalid protected source prefix"))?;
        if !protected.iter().any(|path| path == change) || !seen.insert(change) {
            return Err(crate::err(
                "Source integrity contains an unapproved protected prefix",
            ));
        }
    }
    fields["protected_changes"] = proof["protected_changes"].clone();
    Ok(fields)
}

pub(crate) fn blocked_report(fields: Value, policy: &yoneda_core::Policy) -> Option<Value> {
    if fields["protected_changes"]
        .as_array()
        .is_none_or(|paths| paths.is_empty())
    {
        return None;
    }
    let mut report = serde_json::json!({"setup":[],"commands":[],"environment":yoneda_core::build::ENVIRONMENT,"suite":policy.suite});
    if let (Some(report), Some(fields)) = (report.as_object_mut(), fields.as_object()) {
        report.extend(fields.clone());
    }
    Some(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use yoneda_core::{
        Policy,
        build::{CommandSpec, TestBundlePolicy},
    };
    fn policy() -> Policy {
        Policy {
            suite: "commands-v1".into(),
            environment: yoneda_core::build::ENVIRONMENT.into(),
            required_checks: vec!["protected".into()],
            build: Some(BuildProfile {
                app: None,
                setup: vec![],
                checks: vec![CommandSpec {
                    name: "protected".into(),
                    argv: vec!["node".into(), "/opt/yoneda/test-bundle/run.mjs".into()],
                    timeout_seconds: 30,
                }],
                static_dir: None,
                test_bundle: Some(TestBundlePolicy {
                    digest: "a".repeat(64),
                    protected_paths: vec!["tests".into()],
                }),
            }),
            ..Policy::default()
        }
    }
    fn job(policy: &Policy, protected: Value) -> Value {
        let policy = serde_json::to_value(policy).unwrap();
        let revision = json!({"repository":"repo","commit":"1".repeat(40)});
        json!({"payload":{"workspace_transport":"api-source-v1","policy":policy,"candidate":{"id":"candidate","revision":revision,"paths_ref":{"version":1,"id":"paths","count":10000,"digest":"d".repeat(64)}},"source_integrity":{"version":1,"candidate_id":"candidate","revision":revision,"paths_digest":"d".repeat(64),"protected_changes":protected,"policy_digest":yoneda_core::fingerprint(&policy).unwrap()}}})
    }
    fn check(protected: Value) -> String {
        let policy = policy();
        let profile = policy.build.as_ref().unwrap();
        let job = job(&policy, protected);
        let mut report = json!({"commands":[{"name":"protected","output":{"exit":0}}],"setup":[],"environment":yoneda_core::build::ENVIRONMENT,"suite":policy.suite});
        report.as_object_mut().unwrap().extend(
            fields(&job, profile, Some(&"a".repeat(64)))
                .unwrap()
                .as_object()
                .unwrap()
                .clone(),
        );
        yoneda_core::build::checks_from_report(&policy, &report).unwrap()[0]
            .status
            .clone()
    }
    #[test]
    fn api_captured_path_oracle_accepts_unchanged_bundle_but_dirty_fails_even_checks_zero() {
        assert_eq!(check(json!([])), "pass");
        assert_eq!(check(json!(["tests"])), "fail");
        assert_eq!(check(json!(["tests"])), "fail");
    }
    #[test]
    fn missing_or_malformed_captured_paths_fail_closed_not_empty_default() {
        let policy = policy();
        let profile = policy.build.as_ref().unwrap();
        for field in ["candidate_id", "revision", "paths_digest", "policy_digest"] {
            let mut forged = job(&policy, json!([]));
            forged["payload"]["source_integrity"][field] = json!("forged");
            assert!(fields(&forged, profile, None).is_err());
        }
        let mut missing = job(&policy, json!([]));
        missing["payload"]["source_integrity"] = Value::Null;
        assert!(fields(&missing, profile, None).is_err());
        for changes in [
            json!(["src/main.rs"]),
            json!(["tests", "tests"]),
            json!([42]),
        ] {
            assert!(fields(&job(&policy, changes), profile, None).is_err());
        }
    }
}
