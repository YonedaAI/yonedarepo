use super::fixtures as f;
use crate::native::NativeStore;
use crate::storage::{get, repo, run_jobs};
use serde_json::{Value, json};

#[path = "comparison_accounting_tests.rs"]
mod comparison_accounting_tests;
#[path = "comparison_selection_tests.rs"]
mod comparison_selection_tests;

fn input() -> Value {
    let mut c = f::input();
    c["agents"] = json!([
        {"provider":"zai","model":"glm-5.3-flash","connection":"builder-glm","strategy":"minimal","reasoning_effort":"high"},
        {"provider":"claude","model":"claude-sonnet-5-5","connection":"builder-sonnet","strategy":"defensive"}
    ]);
    c["_comparison_reviewer"] =
        json!({"provider":"zai","model":"glm-5.3-flash","connection":"reviewer-glm"});
    c["_comparison_reviewer_budget"] = f::budget("zai", "glm-5.3-flash");
    c["model_budgets"] = json!([
        f::budget("zai", "glm-5.3-flash"),
        f::budget("claude", "claude-sonnet-5-5")
    ]);
    c["working_branch_id"] = json!("development");
    c["expected_working_commit"] = json!("a".repeat(40));
    c["expected_working_version"] = json!(0);
    c
}

fn db() -> NativeStore {
    let db = f::db();
    f::call(
        &db,
        json!({"op":"create_working_branch","id":"development",
        "expected_commit":"a".repeat(40),"expected_version":0}),
    )
    .unwrap();
    db
}

fn ready() -> (NativeStore, Value, Value) {
    let db = db();
    f::call(&db, input()).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    let job = reviewer(&db);
    let context = f::call(
        &db,
        json!({"op":"comparison_context","job_id":job["id"],"epoch":job["epoch"]}),
    )
    .unwrap();
    (db, job, context)
}

fn reviewer(db: &NativeStore) -> Value {
    let job = run_jobs(db, "compare")
        .unwrap()
        .into_iter()
        .find(|j| {
            j["payload"]["execution"]["comparison_role"] == "reviewer" && j["status"] == "queued"
        })
        .unwrap();
    f::call(db, json!({"op":"claim","job_id":job["id"]})).unwrap()
}

fn submit(job: &Value, context: &Value, outcome: &str) -> Value {
    let alternatives: Vec<Value> = context["manifest"]["alternatives"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            json!({"candidate_id":a["candidate_id"],"execution_id":a["execution_id"],
            "reason":"This independently checked booking approach preserves capacity"})
        })
        .collect();
    json!({"op":"comparison_submit","job_id":job["id"],"epoch":job["epoch"],
        "request_id":"review-receipt","manifest_digest":context["manifest_digest"],
        "outcome":outcome,"candidate_id":context["manifest"]["alternatives"][0]["candidate_id"],
        "rationale":"Prefer capacity-safe transaction boundaries to preserve booking integrity",
        "alternatives":alternatives,"risks":[],"evidence_refs":[],
        "repair_instructions":"Tighten cancellation transaction boundaries within the approved booking goal"})
}

fn complete(db: &NativeStore, job: &Value, unchanged: bool) -> yoneda_core::Result<Value> {
    f::call(
        db,
        json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],
        "result":{"review_only":true,"source_unchanged":unchanged,"transcript":"e".repeat(64)}}),
    )
}

fn reserve(db: &NativeStore, job: &Value) -> yoneda_core::Result<Value> {
    f::call(
        db,
        json!({"op":"reserve_request","job_id":job["id"],"epoch":job["epoch"],
        "kind":"model","input_bytes":10,"output_tokens":256}),
    )
}

#[test]
fn submitted_selection_waits_for_trusted_completion_and_replays_without_advancing_twice() {
    let (db, job, context) = ready();
    let request = submit(&job, &context, "selected");
    let receipt = f::call(&db, request.clone()).unwrap();
    assert_eq!(f::call(&db, request.clone()).unwrap(), receipt);
    assert_eq!(
        get(&db, "working_branches", "development").unwrap()["version"],
        0
    );
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
    let proposal = get(&db, "nodes", receipt["review_id"].as_str().unwrap()).unwrap();
    assert_eq!(proposal["kind"], "proposed_decision");
    assert_eq!(
        proposal["data"]["alternatives"].as_array().unwrap().len(),
        2
    );
    assert_eq!(proposal["data"]["selected_candidate_id"], "candidate-1");

    complete(&db, &job, true).unwrap();
    assert_eq!(
        get(&db, "working_branches", "development").unwrap()["version"],
        1
    );
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    // A lost acknowledgement may return a receipt or fence a terminal attempt,
    // but replay cannot create a second selection or a coding/capture job.
    let _ = complete(&db, &job, true);
    let _ = f::call(&db, request);
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
}

#[test]
fn proposal_cannot_select_or_launch_repair_after_failed_or_untrusted_harness_completion() {
    for outcome in ["selected", "repair_requested"] {
        for failure in ["harness", "source", "expired"] {
            let (db, job, context) = ready();
            let receipt = f::call(&db, submit(&job, &context, outcome)).unwrap();
            match failure {
                "harness" => {
                    f::call(&db, json!({"op":"fail","job_id":job["id"],"epoch":job["epoch"],
                        "retryable":false,"error":{"code":"HARNESS_FIXTURE","message":"Synthetic harness failure"}})).unwrap();
                }
                "source" => {
                    assert!(complete(&db, &job, false).is_err());
                }
                _ => {
                    assert!(f::call(&db, json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],
                        "now":job["lease_until"].as_i64().unwrap()+1,
                        "result":{"review_only":true,"source_unchanged":true,"transcript":"e".repeat(64)}})).is_err());
                }
            }
            assert_eq!(
                get(&db, "working_branches", "development").unwrap()["version"],
                0,
                "{outcome}/{failure}"
            );
            assert!(
                !run_jobs(&db, "compare")
                    .unwrap()
                    .iter()
                    .any(|j| j["payload"]["execution"]["comparison_role"] == "repair"),
                "{outcome}/{failure}"
            );
            assert!(get(&db, "nodes", receipt["review_id"].as_str().unwrap()).is_ok());
        }
    }
}

#[test]
fn review_round_limit_survives_retry_epoch_and_builder_high_does_not_force_reviewer_effort() {
    let (db, job, _) = ready();
    assert!(job["payload"]["execution"]["reasoning_effort"].is_null());
    for _ in 0..7 {
        reserve(&db, &job).unwrap();
    }
    f::call(
        &db,
        json!({"op":"fail","job_id":job["id"],"epoch":job["epoch"],"retryable":true,
        "error":{"code":"RETRY_FIXTURE","message":"Synthetic retry before review result"}}),
    )
    .unwrap();
    let retry = f::call(&db, json!({"op":"claim","job_id":job["id"]})).unwrap();
    assert_eq!(retry["epoch"], 2);
    assert!(reserve(&db, &job).is_err());
    for _ in 0..5 {
        reserve(&db, &retry).unwrap();
    }
    let before = get(&db, "runs", "compare").unwrap();
    assert_eq!(
        before["comparison"]["review_requests_by_round"],
        json!([12, 0, 0])
    );
    assert!(reserve(&db, &retry).is_err());
    assert_eq!(get(&db, "runs", "compare").unwrap(), before);
}

#[test]
fn retried_harness_cannot_complete_an_earlier_epochs_untrusted_proposal() {
    for outcome in ["selected", "repair_requested"] {
        let (db, job, context) = ready();
        let receipt = f::call(&db, submit(&job, &context, outcome)).unwrap();
        f::call(&db, json!({"op":"fail","job_id":job["id"],"epoch":job["epoch"],"retryable":true,
            "error":{"code":"RETRY_FIXTURE","message":"Harness failed after submitting an assertion"}})).unwrap();
        let retry = f::call(&db, json!({"op":"claim","job_id":job["id"]})).unwrap();
        assert_eq!(retry["epoch"], 2);
        assert!(
            complete(&db, &retry, true).is_err(),
            "Epoch 2 cannot certify epoch 1's assertion"
        );
        assert_eq!(
            get(&db, "working_branches", "development").unwrap()["version"],
            0
        );
        assert!(
            !run_jobs(&db, "compare")
                .unwrap()
                .iter()
                .any(|j| j["payload"]["execution"]["comparison_role"] == "repair")
        );
        let assertion = get(&db, "nodes", receipt["review_id"].as_str().unwrap()).unwrap();
        assert_eq!(assertion["data"]["producer_epoch"], 1);
    }
}

#[test]
fn forged_review_or_cancelled_attempt_cannot_record_a_selection() {
    let (db, job, context) = ready();
    let request = submit(&job, &context, "selected");
    for field in ["manifest_digest", "candidate_id"] {
        let mut forged = request.clone();
        forged[field] = json!(if field == "manifest_digest" {
            "0".repeat(64)
        } else {
            "foreign-candidate".to_owned()
        });
        let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
        assert!(f::call(&db, forged).is_err());
        assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
    }
    let mut partial = request.clone();
    partial["alternatives"].as_array_mut().unwrap().pop();
    assert!(f::call(&db, partial).is_err());
    f::call(&db, json!({"op":"cancel_run","run_id":"compare"})).unwrap();
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(f::call(&db, request).is_err());
    assert!(complete(&db, &job, true).is_err());
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
}
