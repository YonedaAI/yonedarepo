//! A completed check's evidence names what it ran against: the run's commit and tree, and
//! (for a command check) a digest of the files shipped to the container. The authority
//! refuses a verdict whose evidence names anything else, so a result can never be
//! attributed to a tree it did not run on.
use super::*;

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
