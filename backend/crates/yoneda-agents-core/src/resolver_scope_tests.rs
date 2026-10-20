//! Resolver write scope: any valid unprotected path.
use super::validate_edits;

#[test]
fn resolver_may_edit_paths_outside_the_conflicting_set() {
    let frozen = ["config/secret-tests"];
    validate_edits(
        ["public/style.css", "public/tasks.mjs", "src/new.mjs"],
        &frozen,
    )
    .unwrap();
    validate_edits(["public/app.mjs"], &[]).unwrap();
}

#[test]
fn guided_and_policy_protected_paths_stay_forbidden() {
    let frozen = ["config/secret-tests/"];
    for path in [
        "README.md",
        ".yoneda-guided",
        "fixtures/guided-task-board/oracle/run.mjs",
        "config/secret-tests/check.mjs",
    ] {
        let error = validate_edits(["public/tasks.mjs", path], &frozen).unwrap_err();
        assert_eq!(error.code, "INVALID_CONFLICT_RESULT", "{path}");
    }
    // A sibling sharing a protected name prefix is not itself protected.
    validate_edits(
        ["README.md.bak", "fixtures/guided-task-board/oracle-notes"],
        &frozen,
    )
    .unwrap();
}

#[test]
fn unsafe_resolver_paths_are_refused() {
    for path in ["../escape", "/abs", ".git/config"] {
        assert!(validate_edits([path], &[]).is_err(), "{path}");
    }
}
