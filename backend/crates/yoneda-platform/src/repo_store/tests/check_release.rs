//! A claim whose executor never started (no container capacity) is given back: the run is
//! queued again without spending one of its attempts, so waiting for capacity can never
//! error a run. Only the claiming epoch can release, and only while it is still running.
use super::*;

#[test]
fn released_claims_requeue_the_run_without_spending_attempts() {
    let (h, root) = seeded();
    let policy = json!({"required_checks":["unit"],"approvals":0,
        "runners":{"unit":{"command":["sh","-c","test"],"timeout_seconds":60}}});
    h.ok(OWNER, json!({"op":"repo_set_policy","policy":policy}));
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    let run = h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["check_runs"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Far more capacity refusals than MAX_ATTEMPTS: each claim is the first attempt again.
    for _ in 0..5 {
        let claimed = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}));
        assert_eq!(claimed["epoch"], 1);
        let released = h.ok(
            SYSTEM,
            json!({"op":"repo_check_release","run_id":run,"epoch":1}),
        );
        assert_eq!(released["released"], true);
        let shown = h.ok(SYSTEM, json!({"op":"repo_check_run","run_id":run}));
        assert_eq!(shown["status"], "queued");
    }
    // Only the holder's epoch releases, only while running; only the platform (or the owner,
    // as for claims) may.
    let claim = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}));
    let epoch = claim["epoch"].clone();
    let stale = json!({"op":"repo_check_release","run_id":run,"epoch":7});
    assert_eq!(h.ok(SYSTEM, stale)["released"], false);
    let release = json!({"op":"repo_check_release","run_id":run,"epoch":epoch});
    for caller in [AGENT, CI] {
        assert_eq!(code(h.run(caller, release.clone())), "FORBIDDEN");
    }
    h.ok(
        SYSTEM,
        json!({"op":"repo_check_complete","run_id":run,"epoch":epoch,"outcome":"pass","evidence":ran_on(&claim)}),
    );
    assert_eq!(h.ok(SYSTEM, release)["released"], false);
    let shown = h.ok(SYSTEM, json!({"op":"repo_check_run","run_id":run}));
    assert_eq!(shown["status"], "passed");
}

/// A command runner's sparse scope: validated paths, handed to the executor with the claim,
/// and invisible to a policy without one (its digest is the one recorded before scopes).
#[test]
fn a_runner_scope_is_validated_claimed_and_leaves_old_policies_alone() {
    let (h, root) = seeded();
    for paths in [
        json!(["../out"]),
        json!(["/abs"]),
        json!([".git"]),
        json!((0..33).map(|i| format!("d{i}")).collect::<Vec<_>>()),
    ] {
        let policy = json!({"required_checks":["unit"],"approvals":0,
            "runners":{"unit":{"command":["true"],"paths":paths}}});
        let refused = code(h.run(OWNER, json!({"op":"repo_set_policy","policy":policy})));
        assert!(
            ["INVALID_INPUT", "UNSAFE_PATH"].contains(&refused.as_str()),
            "{paths}: {refused}"
        );
    }
    let plain = json!({"required_checks":["unit"],"approvals":0,
        "runners":{"unit":{"command":["true"],"timeout_seconds":60}}});
    let before =
        h.ok(OWNER, json!({"op":"repo_set_policy","policy":plain}))["policy_digest"].clone();
    let again = json!({"required_checks":["unit"],"approvals":0,
        "runners":{"unit":{"command":["true"],"timeout_seconds":60,"paths":[]}}});
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_set_policy","policy":again}))["policy_digest"],
        before
    );
    let scoped = json!({"required_checks":["unit"],"approvals":0,
        "runners":{"unit":{"command":["true"],"timeout_seconds":60,"paths":["src","docs/api.md"]}}});
    h.ok(OWNER, json!({"op":"repo_set_policy","policy":scoped}));
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/a.rs", "a\n")]),
            json!([]),
        )
        .unwrap();
    let run = h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["check_runs"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let claimed = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}));
    assert_eq!(claimed["paths"], json!(["src", "docs/api.md"]));
}
