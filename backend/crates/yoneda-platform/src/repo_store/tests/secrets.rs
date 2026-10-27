//! Commits carrying credentials are refused before they are built, on the authority and the
//! stateless path alike; only the owner can accept a false positive, by path and rule.
//! Fake tokens are assembled at runtime so this source holds none.
use super::*;

fn fake_github_token() -> String {
    ["gh", "p_"].concat()
        + &"aB3dE5gH7jK9mN1pQ"
            .chars()
            .cycle()
            .take(36)
            .collect::<String>()
}

#[test]
fn commits_with_secrets_are_refused_until_the_owner_allows_them() {
    let (h, root) = seeded();
    let leak = format!("const a = 1;\nconst token = \"{}\";\n", fake_github_token());
    let refused = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/env.ts", &leak)]),
            json!([]),
        )
        .unwrap_err();
    assert_eq!(refused.code, "SECRET_DETECTED");
    assert!(
        refused.message.contains("src/env.ts line 2"),
        "{}",
        refused.message
    );
    assert!(!refused.message.contains(&fake_github_token()));
    // Nothing was recorded or staged for the refused change.
    assert_eq!(h.ok(OWNER, json!({"op":"repo_status"}))["version"], 1);

    let allow = json!({"required_checks":["unit"],"approvals":1,
        "check_posters":{"unit":["owner","token:ci"]},
        "secret_allow":[{"path":"src/env.ts","rule":"github-token"}]});
    let set = json!({"op":"repo_set_policy","policy":allow});
    assert_eq!(code(h.run(AGENT, set.clone())), "FORBIDDEN");
    assert_eq!(code(h.run(CI, set.clone())), "FORBIDDEN");
    h.ok(OWNER, set);
    assert!(
        h.commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/env.ts", &leak)]),
            json!([])
        )
        .is_ok()
    );
    // The allowance names one path: the same token elsewhere is still refused.
    let elsewhere = h.commit(
        AGENT,
        Some(&root),
        1,
        json!([file("src/other.ts", &leak)]),
        json!([]),
    );
    assert_eq!(elsewhere.unwrap_err().code, "SECRET_DETECTED");
}

#[test]
fn policy_rejects_malformed_secret_allowances() {
    let h = Harness::new();
    for entry in [
        json!({"path":"src/env.ts","rule":"everything"}),
        json!({"path":"","rule":"github-token"}),
        json!({"path":"src/env.ts"}),
    ] {
        let set = json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0,"secret_allow":[entry]}});
        assert_eq!(code(h.run(OWNER, set)), "INVALID_INPUT", "{entry}");
    }
}

#[test]
fn the_stateless_build_refuses_secrets_too() {
    let built = crate::platform_build::build_commit(&json!({
        "now": 1_700_000_000_000_i64, "parent": null, "trees": {},
        "changes": [file("deploy/key.txt", &fake_github_token())],
        "message": "m", "author": {"name": "A", "email": "a@example.com"},
    }));
    assert_eq!(code(built), "SECRET_DETECTED");
}
