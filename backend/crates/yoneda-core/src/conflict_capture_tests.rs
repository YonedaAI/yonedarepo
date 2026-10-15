//! Resolver capture boundary: any valid unprotected path, reserved head, Git readback.
use super::validate_capture_result;
use serde_json::{Value, json};

fn head() -> String {
    "a".repeat(40)
}

fn job(extra: Value) -> Value {
    let mut payload = json!({"capture_subtype":"resolve_conflict","expected_head":head(),"expected_version":3,"conflict_paths":["public/tasks.mjs"]});
    for (key, value) in extra.as_object().unwrap() {
        payload[key] = value.clone();
    }
    json!({"kind":"capture","id":"capture:resolver","epoch":2,"status":"running","payload":payload})
}

fn result(delta: &[&str]) -> Value {
    let commit = "c".repeat(40);
    json!({"id":"candidate:resolved","tree":"d".repeat(40),"revision":{"commit":commit},"paths":delta,"resolver_delta_paths":delta,
        "readback":{"observed_head":head(),"version":3,"parents":[head()],"candidate_commit":commit,"resolver_delta_paths":delta,"captured_paths":delta}})
}

fn check(extra: Value, delta: &[&str]) -> crate::Result<()> {
    validate_capture_result(&job(extra), "capture:resolver", 2, &result(delta))
}

#[test]
fn resolver_may_edit_paths_outside_the_conflicting_set() {
    let frozen = json!({"resolver_protected_paths":["config/secret-tests"]});
    check(
        frozen.clone(),
        &["public/style.css", "public/tasks.mjs", "src/new.mjs"],
    )
    .unwrap();
    check(json!({}), &["public/app.mjs"]).unwrap();
}

#[test]
fn guided_and_policy_protected_paths_stay_forbidden() {
    let frozen = json!({"resolver_protected_paths":["config/secret-tests/"]});
    for path in [
        "README.md",
        ".yoneda-guided",
        "fixtures/guided-task-board/oracle/run.mjs",
        "config/secret-tests/check.mjs",
    ] {
        let error = check(frozen.clone(), &["public/tasks.mjs", path]).unwrap_err();
        assert_eq!(error.code, "INVALID_CONFLICT_RESULT", "{path}");
    }
    // A sibling sharing a protected name prefix is not itself protected.
    check(
        frozen,
        &["README.md.bak", "fixtures/guided-task-board/oracle-notes"],
    )
    .unwrap();
}

#[test]
fn unsafe_empty_or_unbased_resolver_captures_are_still_refused() {
    for delta in [&["../escape"][..], &["/abs"], &[".git/config"], &[]] {
        assert!(check(json!({}), delta).is_err(), "{delta:?}");
    }
    let mut moved = result(&["public/tasks.mjs"]);
    moved["readback"]["parents"] = json!(["b".repeat(40)]);
    assert!(validate_capture_result(&job(json!({})), "capture:resolver", 2, &moved).is_err());
    let mut malformed = job(json!({}));
    malformed["payload"]["resolver_protected_paths"] = json!("README.md");
    assert!(
        validate_capture_result(&malformed, "capture:resolver", 2, &result(&["a.mjs"])).is_err()
    );
}
