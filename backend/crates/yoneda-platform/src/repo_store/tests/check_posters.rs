//! Who may post a check: a required check is bound to the platform's own run (a policy
//! runner) or to named posters; informational checks stay open to any `check` token.
use super::*;

const BOTH: &str = "token:both";

fn post(h: &Harness, principal: &str, commit: &str, name: &str) -> String {
    code(h.run(
        principal,
        json!({"op":"repo_check","commit":commit,"name":name,"status":"pass"}),
    ))
}

fn policy(h: &Harness, policy: Value) -> yoneda_core::Result<Value> {
    h.run(OWNER, json!({"op":"repo_set_policy","policy":policy}))
}

#[test]
fn required_checks_are_posted_only_by_their_bound_posters() {
    let (h, root) = seeded();
    // A token that writes and checks must not be able to pass its own work.
    h.ok(OWNER, json!({"op":"repo_token_create","name":"both","scopes":["read","write","check"],"_secret":"both-secret-0123456789abcdef0123456789"}));
    policy(
        &h,
        json!({"required_checks":["unit","build"],"approvals":1,
            "runners":{"build":{"command":["make"]}},
            "check_posters":{"unit":["token:ci"]}}),
    )
    .unwrap();
    let id = h
        .commit(
            BOTH,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(post(&h, BOTH, &id, "unit"), "FORBIDDEN");
    assert_eq!(post(&h, OWNER, &id, "unit"), "FORBIDDEN");
    assert_eq!(post(&h, CI, &id, "unit"), "OK");
    // A runner's result comes only from the platform's fenced run, never by hand.
    for principal in [CI, OWNER, BOTH] {
        assert_eq!(post(&h, principal, &id, "build"), "FORBIDDEN");
    }
    // Informational checks stay open to any check token.
    assert_eq!(post(&h, BOTH, &id, "style"), "OK");
    assert_eq!(post(&h, CI, &id, "lint"), "OK");

    // Without bound posters, a required check is the owner's alone.
    policy(&h, json!({"required_checks":["unit"],"approvals":1})).unwrap();
    assert_eq!(post(&h, CI, &id, "unit"), "FORBIDDEN");
    assert_eq!(post(&h, OWNER, &id, "unit"), "OK");
    policy(
        &h,
        json!({"required_checks":["unit"],"approvals":1,"check_posters":{"unit":["owner","token:ci"]}}),
    )
    .unwrap();
    assert_eq!(post(&h, OWNER, &id, "unit"), "OK");
    assert_eq!(post(&h, CI, &id, "unit"), "OK");
}

#[test]
fn policies_without_posters_keep_their_digest() {
    let h = Harness::new();
    let plain = json!({"required_checks":["unit"],"approvals":1});
    let set = policy(&h, plain.clone()).unwrap();
    assert_eq!(set["policy"], plain);
    assert_eq!(
        set["policy_digest"],
        json!(yoneda_core::fingerprint(&plain).unwrap())
    );
}

#[test]
fn policy_rejects_unbound_or_malformed_posters() {
    let h = Harness::new();
    for posters in [
        json!({"lint":["token:ci"]}),
        json!({"build":["token:ci"]}),
        json!({"unit":[]}),
        json!({"unit":["user:someone"]}),
        json!({"unit":["token:"]}),
        json!({"unit":["token:Bad Name"]}),
    ] {
        let result = policy(
            &h,
            json!({"required_checks":["unit","build"],"approvals":1,
                "runners":{"build":{"command":["make"]}},"check_posters":posters}),
        );
        assert_eq!(code(result), "INVALID_INPUT", "{posters}");
    }
}
