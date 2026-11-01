//! A completed check's evidence names what it ran against: the run's commit and tree, and
//! (for a command check) a digest of the files shipped to the container. The authority
//! refuses a verdict whose evidence names anything else, so a result can never be
//! attributed to a tree it did not run on.
use super::*;
use crate::storage::SqlStore;

const FILES: &str = "5f2b51ca2fdc5baa31ec02e002f69aec4bcd2d1ab0e9b1c5d5d0d4bc2e2c1f00";

/// A claimed run of a command check on a fresh commit: (harness, run id, claim).
fn claimed() -> (Harness, String, Value) {
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
    let claim = h.ok(SYSTEM, json!({"op":"repo_check_claim","run_id":run}));
    (h, run, claim)
}

fn complete(h: &Harness, run: &str, claim: &Value, outcome: &str, evidence: Value) -> String {
    code(h.run(
        SYSTEM,
        json!({"op":"repo_check_complete","run_id":run,"epoch":claim["epoch"],
               "outcome":outcome,"evidence":evidence}),
    ))
}

#[test]
fn verdicts_must_name_the_commit_tree_and_files_they_ran_against() {
    let (h, run, claim) = claimed();
    let other_tree = "e".repeat(40);
    let other_commit = "d".repeat(40);
    for evidence in [
        json!({"exit_code":0}),
        json!({"commit":claim["commit"],"tree":other_tree,"files_sha256":FILES}),
        json!({"commit":other_commit,"tree":claim["tree"],"files_sha256":FILES}),
        json!({"commit":claim["commit"],"tree":claim["tree"]}),
        json!({"commit":claim["commit"],"tree":claim["tree"],"files_sha256":"not-a-digest"}),
    ] {
        for outcome in ["pass", "fail"] {
            assert_eq!(
                complete(&h, &run, &claim, outcome, evidence.clone()),
                "EVIDENCE_MISMATCH",
                "{evidence}"
            );
        }
    }
    // Nothing was recorded by the refused verdicts: the run is still the executor's.
    let shown = h.ok(SYSTEM, json!({"op":"repo_check_run","run_id":run}));
    assert_eq!(shown["status"], "running");
    let good =
        json!({"commit":claim["commit"],"tree":claim["tree"],"files_sha256":FILES,"exit_code":0});
    assert_eq!(complete(&h, &run, &claim, "pass", good), "OK");
    let recorded =
        h.ok(OWNER, json!({"op":"repo_commit","commit":claim["commit"]}))["checks"][0].clone();
    let evidence: Value = serde_json::from_str(recorded["evidence"].as_str().unwrap()).unwrap();
    assert_eq!(evidence["tree"], claim["tree"]);
}

#[test]
fn an_infrastructure_error_needs_no_evidence_of_a_run() {
    let (h, run, claim) = claimed();
    assert_eq!(
        complete(&h, &run, &claim, "error", json!({"error":"container"})),
        "OK"
    );
}

/// A finished run of `outcome` as the two reads show it, and what `check_runs` stored.
fn finished(switches: Value, outcome: &str) -> (Value, Value, Value) {
    let (h, run, claim) = claimed();
    *h.switches.borrow_mut() = switches;
    let evidence = match outcome {
        "error" => json!({"error":"container"}),
        _ => json!({"commit":claim["commit"],"tree":claim["tree"],"files_sha256":FILES,
                    "exit_code":0,"log":"platform/v1/r/checks/x"}),
    };
    assert_eq!(complete(&h, &run, &claim, outcome, evidence), "OK");
    let stored =
        h.db.query("SELECT result FROM check_runs", &[])
            .unwrap()
            .remove(0);
    let commit = h.ok(OWNER, json!({"op":"repo_commit","commit":claim["commit"]}));
    (
        h.ok(SYSTEM, json!({"op":"repo_check_run","run_id":run}))["result"].clone(),
        commit["check_runs"][0]["result"].clone(),
        stored["result"].clone(),
    )
}

#[test]
fn a_verdict_is_stored_once_behind_the_switch_and_reads_as_before() {
    let once = json!({"_check_evidence":"once"});
    for outcome in ["pass", "fail"] {
        let (run, listed, stored) = finished(json!({}), outcome);
        assert!(stored.is_string(), "off, the run keeps its copy");
        let (run_once, listed_once, stored_once) = finished(once.clone(), outcome);
        assert_eq!(stored_once, Value::Null, "on, only `checks` holds it");
        // The `/check-runs/:id/log` route reads `log` from this answer.
        assert_eq!(run_once["log"], "platform/v1/r/checks/x");
        // Same evidence, and the list keeps showing it as the stored JSON text.
        let same = |a: &Value, b: &Value| {
            assert_eq!(a["log"], b["log"]);
            assert_eq!(a["files_sha256"], b["files_sha256"]);
        };
        same(&run, &run_once);
        let text = |v: &Value| serde_json::from_str::<Value>(v.as_str().unwrap()).unwrap();
        same(&text(&listed), &text(&listed_once));
    }
}

#[test]
fn an_errored_run_keeps_its_own_result_and_a_live_run_shows_none() {
    // An error writes no check, so the run's copy is the only one.
    let (run, _, stored) = finished(json!({"_check_evidence":"once"}), "error");
    assert_eq!(run["error"], "container");
    assert!(stored.is_string());
    // A run still going has no result, whatever `checks` holds for its commit.
    let (h, run, _) = claimed();
    assert_eq!(
        h.ok(SYSTEM, json!({"op":"repo_check_run","run_id":run}))["result"],
        Value::Null
    );
}

#[test]
fn a_posted_check_cannot_replace_the_verdict_a_run_shows() {
    // The run's result is read from `checks` under the run's own policy digest. A policy
    // with that digest has this runner, and a runner's name refuses posted checks.
    let (h, _, claim) = claimed();
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_check","commit":claim["commit"],"name":"unit","status":"pass"})
        )),
        "FORBIDDEN"
    );
}
