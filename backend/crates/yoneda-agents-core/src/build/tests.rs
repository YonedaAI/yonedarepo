use super::*;
use serde_json::json;

fn policy() -> Policy {
    serde_json::from_value(json!({"version":"v1","suite":"commands-v1",
        "environment":ENVIRONMENT,"required_checks":["tests"],"build":{"checks":[
            {"name":"tests","argv":["sh","/opt/yoneda/test-bundle/run.sh"],"timeout_seconds":10}],
            "test_bundle":{"digest":"a".repeat(64),"protected_paths":["tests","scripts/runner.sh"]}}})).unwrap()
}

#[test]
fn app_manifest_is_versioned_and_owner_approved() {
    let mut value = serde_json::to_value(policy()).unwrap();
    value["build"]["app"] = json!({"version":1,"entrypoint":"dist/worker.js",
        "export_name":"App","migrations":[{"version":1,
        "sql":["CREATE TABLE bookings (id TEXT PRIMARY KEY)"]}],"seed":[]});
    let p: Policy = serde_json::from_value(value.clone()).unwrap();
    assert!(validate_policy(&p).is_ok());
    for sql in [
        "DROP TABLE bookings",
        "ALTER TABLE bookings DROP COLUMN id",
        "CREATE TABLE x (id); DROP TABLE bookings",
        "CREATE TABLE x (id) -- comment",
    ] {
        value["build"]["app"]["migrations"][0]["sql"][0] = json!(sql);
        let p: Policy = serde_json::from_value(value.clone()).unwrap();
        assert!(validate_policy(&p).is_err(), "{sql}");
    }
    value["build"]["app"]["version"] = json!(2);
    let p: Policy = serde_json::from_value(value).unwrap();
    assert!(validate_policy(&p).is_err());
}

#[test]
fn app_evaluation_requires_bound_bundle_not_only_successful_command_exit() {
    let mut value = serde_json::to_value(policy()).unwrap();
    value["build"]["app"] = json!({"version":1,"entrypoint":"dist/worker.js",
        "export_name":"App","migrations":[{"version":1,
        "sql":["CREATE TABLE notes (id TEXT)"]}],"seed":[]});
    let policy: Policy = serde_json::from_value(value).unwrap();
    let mut report = json!({"setup":[],"commands":[{"name":"tests","output":{"exit":0}}],
        "test_bundle_digest":"a".repeat(64),"protected_changes":[]});
    assert_eq!(
        checks_from_report(&policy, &report).unwrap()[0].status,
        "fail"
    );
    report["app_bundle_digest"] = json!("b".repeat(64));
    report["app_revision"] = json!("c".repeat(40));
    report["app_policy_digest"] = json!(policy_digest(&policy).unwrap());
    assert_eq!(
        checks_from_report(&policy, &report).unwrap()[0].status,
        "pass"
    );
    report["app_policy_digest"] = json!("d".repeat(64));
    assert_eq!(
        checks_from_report(&policy, &report).unwrap()[0].status,
        "fail"
    );
}

#[test]
fn old_build_profile_without_bundle_remains_valid() {
    let old: BuildProfile = serde_json::from_value(
        json!({"checks":[{"name":"x","argv":["true"],"timeout_seconds":1}]}),
    )
    .unwrap();
    assert!(old.test_bundle.is_none());
}

#[test]
fn bundle_runner_path_must_not_depend_on_unexpanded_shell_variables() {
    let mut policy = policy();
    policy.build.as_mut().unwrap().checks[0].argv[1] = "$YONEDA_TEST_BUNDLE/run.sh".into();
    assert!(validate_policy(&policy).is_err());
}

#[test]
fn zero_exit_cannot_pass_without_exact_bundle_and_clean_protected_paths() {
    let policy = policy();
    let report = json!({"setup":[],"commands":[{"name":"tests","output":{"exit":0}}],
        "test_bundle_digest":"wrong","protected_changes":[]});
    assert_eq!(
        checks_from_report(&policy, &report).unwrap()[0].status,
        "fail"
    );
    let report = json!({"setup":[],"commands":[{"name":"tests","output":{"exit":0}}],
        "test_bundle_digest":"a".repeat(64),"protected_changes":["tests/run.sh"]});
    assert_eq!(
        checks_from_report(&policy, &report).unwrap()[0].status,
        "fail"
    );
    let report = json!({"setup":[],"commands":[{"name":"tests","output":{"exit":0}}],
        "test_bundle_digest":"a".repeat(64),"protected_changes":["src/lib.rs"]});
    assert_eq!(
        checks_from_report(&policy, &report).unwrap()[0].status,
        "pass"
    );
}
