use super::super::lifecycle::wake;
use super::*;
use crate::native::NativeStore;
use fixtures as f;

fn fail(db: &NativeStore, jid: &str) {
    let job = get(db, "jobs", jid).unwrap();
    if job["status"] != "running" {
        f::call(db, json!({"op":"claim","job_id":jid})).unwrap();
    }
    let job = get(db, "jobs", jid).unwrap();
    f::call(db,json!({"op":"fail","job_id":jid,"epoch":job["epoch"],"retryable":false,"error":{"code":"SYNTHETIC_SOURCE_FAILURE","message":"Synthetic source fixture failure"}})).unwrap();
}
fn reviewers(db: &NativeStore) -> Vec<Value> {
    run_jobs(db, "compare")
        .unwrap()
        .into_iter()
        .filter(|j| j["payload"]["comparison_review"] == true)
        .collect()
}
fn captured(db: &NativeStore, index: usize) -> String {
    let eid = format!("compare:agent-{index}");
    let cid = format!("candidate-{index}");
    f::call(db, json!({"op":"claim","job_id":format!("job:{eid}")})).unwrap();
    f::call(db,json!({"op":"finish","job_id":format!("job:{eid}"),"epoch":1,"result":{"workspace":"e".repeat(64)}})).unwrap();
    assert!(reviewers(db).is_empty(), "Pending capture must wait");
    f::call(db, json!({"op":"claim","job_id":format!("capture:{eid}")})).unwrap();
    f::call(db,json!({"op":"finish","job_id":format!("capture:{eid}"),"epoch":1,"result":{"id":cid,"revision":{"repository":"test/fork","commit":"b".repeat(40)},"tree":"f".repeat(40),"paths":["src/booking.rs"],"summary":"Synthetic captured booking","diff_digest":"d".repeat(64)}})).unwrap();
    cid
}
fn checked(db: &NativeStore, cid: &str, status: &str) {
    let jid = format!("evaluate:{cid}");
    f::call(db, json!({"op":"claim","job_id":jid})).unwrap();
    let p = repo(db).unwrap()["policy"].clone();
    let revision = get(db, "candidates", cid).unwrap()["revision"].clone();
    f::call(db,json!({"op":"finish","job_id":jid,"epoch":1,"result":{"id":format!("evaluation-{cid}"),"candidate":cid,"revision":revision,"policy":p["version"],"suite":p["suite"],"environment":p["environment"],"evidence":"e".repeat(64),"checks":[{"name":"build","status":status,"detail":"Synthetic independent evaluation"}]}})).unwrap();
}
fn assert_skipped(db: &NativeStore, before: &Value, canonical: &Value) {
    let run = get(db, "runs", "compare").unwrap();
    assert_eq!(run["comparison"]["status"], "needs_attention");
    assert_eq!(run["status"], "failed");
    assert_eq!(run["comparison"]["reviewer_status"], "skipped");
    assert_eq!(
        run["comparison"]["review_skip_reason"]["code"],
        "NO_CHECKED_RESULTS"
    );
    assert_eq!(
        run["comparison"]["review_skip_reason"]["authority"],
        "platform"
    );
    assert_eq!(run["execution_count"], before["execution_count"]);
    assert_eq!(run["model_requests"], before["model_requests"]);
    assert_eq!(run["model_budgets"], before["model_budgets"]);
    assert_eq!(
        run["comparison"]["approval"],
        before["comparison"]["approval"]
    );
    assert_eq!(
        run["comparison"]["model_budgets"],
        before["comparison"]["model_budgets"]
    );
    assert_eq!(
        run["comparison"]["model_requests"],
        before["comparison"]["model_requests"]
    );
    assert_eq!(
        run["comparison"]["review_requests_by_round"],
        before["comparison"]["review_requests_by_round"]
    );
    assert_eq!(repo(db).unwrap(), *canonical);
    assert!(reviewers(db).is_empty());
    assert!(!run["comparison"]["review_execution_id"].is_string());
    assert_eq!(all(db, "executions").unwrap().len(), 2);
}

#[test]
fn all_failed_builders_skip_review_without_execution_quota_or_spend() {
    let db = f::db();
    f::call(&db,json!({"op":"create_working_branch","id":"development","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    let branch = get(&db, "working_branches", "development").unwrap();
    let mut input = f::input();
    input["working_branch_id"] = json!("development");
    input["expected_working_commit"] = json!("a".repeat(40));
    input["expected_working_version"] = json!(0);
    f::call(&db, input).unwrap();
    let before = get(&db, "runs", "compare").unwrap();
    let canonical = repo(&db).unwrap();
    fail(&db, "job:compare:agent-1");
    assert!(reviewers(&db).is_empty());
    assert_ne!(
        get(&db, "runs", "compare").unwrap()["comparison"]["reviewer_status"],
        "skipped"
    );
    fail(&db, "job:compare:agent-2");
    assert_skipped(&db, &before, &canonical);
    assert_eq!(get(&db, "working_branches", "development").unwrap(), branch);
    assert!(all(&db, "model_reservations").unwrap().is_empty());
    let snapshot = f::call(&db, json!({"op":"snapshot"})).unwrap();
    wake(&db, "compare", 1000).unwrap();
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), snapshot);
}

#[test]
fn pending_capture_and_evaluation_wait_then_one_checked_survivor_is_reviewed() {
    let db = f::db();
    f::start(&db);
    let canonical = repo(&db).unwrap();
    fail(&db, "job:compare:agent-1");
    let cid = captured(&db, 2);
    assert!(reviewers(&db).is_empty());
    assert_eq!(
        get(&db, "runs", "compare").unwrap()["comparison"]["status"],
        "checking"
    );
    checked(&db, &cid, "pass");
    assert_eq!(reviewers(&db).len(), 1);
    assert_eq!(repo(&db).unwrap(), canonical);
    assert!(all(&db, "model_reservations").unwrap().is_empty());
    let run = get(&db, "runs", "compare").unwrap();
    assert_eq!(run["status"], "reviewing");
    assert!(run["comparison"]["review_skip_reason"].is_null());
    let snapshot = f::call(&db, json!({"op":"snapshot"})).unwrap();
    wake(&db, "compare", 1000).unwrap();
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), snapshot);
}

#[test]
fn failed_independent_checks_are_not_reviewable_results() {
    let db = f::db();
    f::start(&db);
    let before = get(&db, "runs", "compare").unwrap();
    let canonical = repo(&db).unwrap();
    fail(&db, "job:compare:agent-1");
    let cid = captured(&db, 2);
    checked(&db, &cid, "fail");
    assert_skipped(&db, &before, &canonical);
}

#[test]
fn failed_evaluator_skips_review_and_retains_pending_model_reservation() {
    let db = f::db();
    f::start(&db);
    f::call(&db, json!({"op":"claim","job_id":"job:compare:agent-1"})).unwrap();
    f::call(&db,json!({"op":"reserve_request","job_id":"job:compare:agent-1","epoch":1,"kind":"model","input_bytes":10,"output_tokens":256})).unwrap();
    fail(&db, "job:compare:agent-1");
    let cid = captured(&db, 2);
    let before = get(&db, "runs", "compare").unwrap();
    let reservations = all(&db, "model_reservations").unwrap();
    let canonical = repo(&db).unwrap();
    fail(&db, &format!("evaluate:{cid}"));
    assert_skipped(&db, &before, &canonical);
    assert_eq!(all(&db, "model_reservations").unwrap(), reservations);
}

#[test]
fn existing_explicit_legacy_review_is_preserved() {
    let db = f::db();
    let mut input = f::input();
    input.as_object_mut().unwrap().remove("comparison");
    f::call(&db, input).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    f::call(&db, f::approval()).unwrap();
    assert_eq!(reviewers(&db).len(), 1);
    let snapshot = f::call(&db, json!({"op":"snapshot"})).unwrap();
    wake(&db, "compare", 1000).unwrap();
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), snapshot);
}

#[test]
fn verification_only_recovery_checks_source_without_spending_remaining_review_requests() {
    for eligible_count in [1, 2] {
        let db = f::db();
        f::start(&db);
        // Synthetic retained owner-recovery state: nine prior logical review
        // requests remain charged. Actual capture and evaluation still execute.
        let mut retained = get(&db, "runs", "compare").unwrap();
        retained["model_requests"] = json!(48);
        for budget in retained["model_budgets"].as_array_mut().unwrap() {
            budget["requests"] = json!(24);
            budget["charged_microusd"] = json!(1000);
        }
        retained["comparison"]["review_requests_by_round"] = json!([9, 0, 0]);
        retained["comparison"]["verification_recovery"] = json!({"version":1,"automatic_review":false,"request_id":"same-seal-recovery","authority":"owner_verification_recovery"});
        save(&db, "runs", "compare", &retained).unwrap();
        let canonical = repo(&db).unwrap();
        if eligible_count == 1 {
            fail(&db, "job:compare:agent-1");
        } else {
            let first = captured(&db, 1);
            checked(&db, &first, "pass");
            assert!(reviewers(&db).is_empty(), "Second builder is still pending");
        }
        let cid = captured(&db, 2);
        assert_eq!(
            get(&db, "runs", "compare").unwrap()["comparison"]["status"],
            "checking"
        );
        checked(&db, &cid, "pass");
        let run = get(&db, "runs", "compare").unwrap();
        assert_eq!(run["comparison"]["status"], "needs_attention");
        assert_eq!(run["status"], "ready");
        assert_eq!(run["comparison"]["reviewer_status"], "skipped");
        assert_eq!(
            run["comparison"]["review_skip_reason"],
            json!({"code":"CAPTURE_RECOVERY_CHECK_ONLY","authority":"platform","message":"Checked captures are ready for human choice"})
        );
        assert_eq!(run["model_requests"], 48);
        for key in [
            "approval",
            "review_requests_by_round",
            "verification_recovery",
        ] {
            assert_eq!(run["comparison"][key], retained["comparison"][key]);
        }
        for key in ["model_budgets", "model_requests", "execution_count"] {
            assert_eq!(run[key], retained[key]);
        }
        assert!(reviewers(&db).is_empty());
        assert!(all(&db, "model_reservations").unwrap().is_empty());
        assert_eq!(repo(&db).unwrap(), canonical);
    }
}
