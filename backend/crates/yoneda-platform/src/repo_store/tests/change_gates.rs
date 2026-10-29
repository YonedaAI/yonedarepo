//! A change's gates: one read listing what its head still needs before it can land on its
//! base (each required check, approvals, unresolved review comments, freshness against the
//! base, a pause), each ready, waiting or blocked with one line of why. Readiness agrees with
//! what landing enforces; what landing does not enforce is shown but never blocks.
use super::*;

fn push(h: &Harness, branch: &str, parent: &str, path: &str) -> String {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file(path, "x\n")]),
            json!([]),
        )
        .unwrap();
    let current =
        h.ok(AGENT, json!({"op":"repo_refs"}))["refs"][format!("refs/heads/{branch}")].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":branch,"commit":id,"expected":current}]}),
    );
    id
}

fn gates(h: &Harness, who: &str) -> Value {
    h.ok(who, json!({"op":"repo_change_gates","number":1}))
}

/// The requirement of `kind` (and `name`, for a check).
fn requirement<'a>(gates: &'a Value, kind: &str, name: Option<&str>) -> &'a Value {
    gates["requirements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == kind && name.is_none_or(|n| r["name"] == n))
        .unwrap_or_else(|| panic!("no {kind} requirement in {gates}"))
}

fn state(gates: &Value, kind: &str, name: Option<&str>) -> (String, bool) {
    let r = requirement(gates, kind, name);
    (
        r["state"].as_str().unwrap().to_owned(),
        r["enforced"].as_bool().unwrap(),
    )
}

#[test]
fn the_gates_list_what_a_change_needs_and_agree_with_landing() {
    let (h, root) = seeded();
    let head = push(&h, "fix", &root, "src/retry.rs");
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Retry"}),
    );

    // Fresh: the check is not reported, no approval, nothing to resolve, up to date.
    let fresh = gates(&h, CI);
    assert_eq!(
        (&fresh["ready"], &fresh["head"], &fresh["base"]),
        (&json!(false), &json!(head), &json!("main"))
    );
    assert_eq!(fresh["base_protected"], true);
    assert_eq!(
        state(&fresh, "check", Some("unit")),
        ("waiting".into(), true)
    );
    assert_eq!(state(&fresh, "approvals", None), ("waiting".into(), true));
    assert!(
        requirement(&fresh, "approvals", None)["why"]
            .as_str()
            .unwrap()
            .contains("0 of 1")
    );
    assert_eq!(state(&fresh, "comments", None), ("ready".into(), false));
    assert_eq!(state(&fresh, "freshness", None), ("ready".into(), false));
    for r in fresh["requirements"].as_array().unwrap() {
        assert!(!r["why"].as_str().unwrap().is_empty(), "{r}");
    }

    // A failing check blocks; landing refuses for the same reason.
    h.ok(
        CI,
        json!({"op":"repo_check","commit":head,"name":"unit","status":"fail"}),
    );
    assert_eq!(
        state(&gates(&h, CI), "check", Some("unit")),
        ("blocked".into(), true)
    );
    h.ok(
        CI,
        json!({"op":"repo_check","commit":head,"name":"unit","status":"pass"}),
    );
    assert_eq!(
        state(&gates(&h, CI), "check", Some("unit")),
        ("ready".into(), true)
    );

    // An unresolved anchored comment waits but is not enforced.
    h.ok(
        OWNER,
        json!({"op":"repo_change_comment","number":1,"body":"nit","commit":head,
               "path":"src/retry.rs","line":1,"side":"new"}),
    );
    h.ok(
        OWNER,
        json!({"op":"repo_change_comment","number":1,"body":"general remark"}),
    );
    let commented = gates(&h, CI);
    assert_eq!(
        state(&commented, "comments", None),
        ("waiting".into(), false)
    );
    assert!(
        requirement(&commented, "comments", None)["why"]
            .as_str()
            .unwrap()
            .starts_with("1 unresolved")
    );

    // Approved: ready, matching the head commit's own gates, though the comment waits.
    h.ok(
        OWNER,
        json!({"op":"repo_review","commit":head,"decision":"approve"}),
    );
    let approved = gates(&h, CI);
    assert_eq!(state(&approved, "approvals", None), ("ready".into(), true));
    assert_eq!(approved["ready"], true);
    let commit = h.ok(CI, json!({"op":"repo_commit","commit":head}));
    assert_eq!(commit["gates"]["ready"], approved["ready"]);

    // The base moves on: the branch is behind (landing merges it), still ready.
    let other = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/other.md", "o\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&other);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":other,"expected_version":1}),
    );
    let behind = gates(&h, CI);
    assert_eq!(state(&behind, "freshness", None), ("waiting".into(), false));
    assert!(
        requirement(&behind, "freshness", None)["why"]
            .as_str()
            .unwrap()
            .contains("1 new commit")
    );
    assert_eq!(behind["ready"], true);

    // A rejection, by another reviewer, blocks.
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"rev","scopes":["read","review"],
               "_secret":"rev-secret-0123456789abcdef0123456789"}),
    );
    h.ok(
        "token:rev",
        json!({"op":"repo_review","commit":head,"decision":"reject","reason":"wrong approach"}),
    );
    let rejected = gates(&h, CI);
    assert_eq!(
        state(&rejected, "approvals", None),
        ("blocked".into(), true)
    );
    assert!(
        requirement(&rejected, "approvals", None)["why"]
            .as_str()
            .unwrap()
            .contains("wrong approach")
    );
    assert_eq!(rejected["ready"], false);
}

#[test]
fn an_unprotected_base_shows_its_gates_without_enforcing_them() {
    let (h, root) = seeded();
    let dev = push(&h, "dev", &root, "src/dev.rs");
    push(&h, "topic", &dev, "src/topic.rs");
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"topic","base":"dev","title":"Topic"}),
    );
    let open = gates(&h, CI);
    assert_eq!(open["base_protected"], false);
    assert_eq!(
        state(&open, "check", Some("unit")),
        ("waiting".into(), false)
    );
    assert_eq!(state(&open, "approvals", None), ("waiting".into(), false));
    assert_eq!(open["ready"], true);
}

#[test]
fn closed_changes_and_restricted_tokens() {
    let (h, root) = seeded();
    push(&h, "fix", &root, "src/retry.rs");
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Retry"}),
    );
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
               "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run("token:docs", json!({"op":"repo_change_gates","number":1}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_change_gates","number":9}))),
        "NOT_FOUND"
    );
    h.ok(AGENT, json!({"op":"repo_change_close","number":1}));
    let closed = gates(&h, CI);
    assert_eq!(closed["ready"], false);
    assert_eq!(state(&closed, "status", None), ("blocked".into(), true));
}
