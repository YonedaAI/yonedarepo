//! Branch policy for landing: protected refs (`main`, `release`, `release/*`) need the `land`
//! scope and passing gates; any other branch lands with `write` and no gates, as a branch
//! move does. The same rule holds for a direct landing, a queued one and a submitted batch.
use super::batches::credentials;
use super::*;

const LANDER: &str = "token:lander";

/// Seeded with the default policy (one `unit` check and one approval), plus a lander token.
fn gated() -> (Harness, String) {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"lander","scopes":["read","write","land"],
        "_secret":"lander-secret-0123456789abcdef0123456789"}),
    );
    (h, root)
}

#[test]
fn a_write_token_lands_on_an_unprotected_branch_without_checks_or_approval() {
    let (h, root) = gated();
    let a = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    let landed = h.ok(
        AGENT,
        json!({"op":"repo_land","ref":"feature/x","commit":a}),
    );
    assert_eq!(
        (landed["landed"].clone(), landed["version"].clone()),
        (json!(true), json!(2))
    );
    // A disjoint commit on the same base joins the branch's queue, still with `write` only.
    let b = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("b.txt", "b\n")]),
            json!([]),
        )
        .unwrap();
    let queued = h.ok(
        AGENT,
        json!({"op":"repo_land","ref":"feature/x","commit":b,"enqueue":true}),
    );
    assert_eq!(queued["queued"], true, "{queued}");
    let again = h.ok(
        AGENT,
        json!({"op":"repo_land_enqueue","ref":"refs/heads/feature/x","commit":b}),
    );
    assert_eq!(again["ticket"], queued["ticket"]);
}

#[test]
fn a_write_token_is_refused_on_every_protected_ref() {
    let (h, root) = gated();
    let a = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&a);
    for refname in ["main", "release", "release/1.0", "refs/heads/main"] {
        for op in ["repo_land", "repo_land_enqueue"] {
            assert_eq!(
                code(h.run(AGENT, json!({"op":op,"ref":refname,"commit":a}))),
                "FORBIDDEN",
                "{op} {refname}"
            );
        }
    }
}

#[test]
fn protected_refs_keep_their_gates_for_a_land_token() {
    let (h, root) = gated();
    let a = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    for refname in ["main", "release/1.0"] {
        assert_eq!(
            code(h.run(LANDER, json!({"op":"repo_land","ref":refname,"commit":a}))),
            "NOT_READY"
        );
        assert_eq!(
            code(h.run(
                LANDER,
                json!({"op":"repo_land_enqueue","ref":refname,"commit":a})
            )),
            "NOT_READY"
        );
    }
    h.approve_and_check(&a);
    let landed = h.ok(LANDER, json!({"op":"repo_land","ref":"main","commit":a}));
    assert_eq!(landed["version"], 2);
}

#[test]
fn a_submitted_batch_applies_the_same_rule() {
    let (h, root) = gated();
    let submit = |refname: &str, principal: &str, record: &Value| {
        h.ok(
            "platform:merge",
            json!({"op":"repo_land_submitted","ref":refname,
            "items":[{"credentials":credentials(principal),"records":[record]}]}),
        )["items"][0]
            .clone()
    };
    // Main: a write-only token is refused; a land token waits for the gates.
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    assert_eq!(submit("main", AGENT, &a)["code"], "FORBIDDEN");
    assert_eq!(submit("main", LANDER, &a)["code"], "NOT_READY");
    // An unprotected branch: the write-only token passes access and gates, and its landing
    // joins that branch's queue (batches serve main; other branches take the queued path).
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"feature/x","commit":root,"expected":null}),
    );
    let queued = submit("feature/x", AGENT, &a);
    assert_eq!(queued["status"], "queued", "{queued}");
}

/// A pushed commit's base version is the version at which its parent was main's head, so it
/// can postdate another commit's landing on an unprotected branch (a CLI push after a
/// teammate landed). That landing is still concurrent work on that branch: the commit joins
/// the merge path, never `STALE_PARENT`. Protected refs keep their rule.
#[test]
fn a_branch_landing_counts_what_landed_there_since_the_commit_parent() {
    let (h, root) = gated();
    h.ok(AGENT, json!({"op":"repo_land","ref":"team","commit":root}));
    let a = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(AGENT, json!({"op":"repo_land","ref":"team","commit":a}));
    let now = h.ok(OWNER, json!({"op":"repo_status"}))["version"]
        .as_u64()
        .unwrap();
    let same = |path: &str, text: &str| {
        h.commit(
            AGENT,
            Some(&root),
            now,
            json!([file(path, text)]),
            json!([]),
        )
        .unwrap()
    };
    // Disjoint work rebases into a merge; work on the same file needs a three-way merge.
    for commit in [same("b.txt", "b\n"), same("a.txt", "other\n")] {
        assert_eq!(
            code(h.run(
                AGENT,
                json!({"op":"repo_land","ref":"team","commit":commit})
            )),
            "MERGE_REQUIRED"
        );
    }
    // Main: the same shape is still a stale parent.
    let main_a = same("m.txt", "m\n");
    h.approve_and_check(&main_a);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":main_a}),
    );
    let later = h.ok(OWNER, json!({"op":"repo_status"}))["version"]
        .as_u64()
        .unwrap();
    let main_b = h
        .commit(
            AGENT,
            Some(&root),
            later,
            json!([file("n.txt", "n\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&main_b);
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":main_b})
        )),
        "STALE_PARENT"
    );
}
