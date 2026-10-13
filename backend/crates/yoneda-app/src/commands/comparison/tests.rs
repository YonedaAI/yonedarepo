use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::Result;
#[path = "tests/comparison_adversarial_tests.rs"]
mod comparison_adversarial_tests;
#[path = "tests/comparison_legacy_selection_tests.rs"]
mod comparison_legacy_selection_tests;
#[path = "tests/fixtures.rs"]
pub(super) mod fixtures;
#[path = "tests/provenance_tests.rs"]
mod provenance_tests;
#[path = "tests/retrieval_tests.rs"]
mod retrieval_tests;
#[path = "tests/selection_tests.rs"]
mod selection_tests;

#[test]
fn start_freezes_comparison_authority_before_scheduling() {
    let db = fixtures::db();
    let run = fixtures::start(&db);
    assert_eq!(run["comparison"]["approval"]["max_review_requests"], 12);
    assert_eq!(
        run["comparison"]["review_requests_by_round"],
        json!([0, 0, 0])
    );
    assert_eq!(run["comparison"]["status"], "building");
    assert_eq!(run["execution_count"], 2);
    let jobs = run_jobs(&db, "compare").unwrap();
    assert_eq!(jobs.len(), 2);
    assert!(
        jobs.iter()
            .all(|j| j["payload"]["execution"]["comparison_approval_id"]
                == run["comparison"]["approval"]["id"])
    );
}

#[test]
fn legacy_approval_preserves_old_counters_and_freshens_all_groups() {
    let db = fixtures::db();
    let mut input = fixtures::input();
    input.as_object_mut().unwrap().remove("comparison");
    let original = fixtures::call(&db, input).unwrap();
    for j in run_jobs(&db, "compare").unwrap() {
        fixtures::call(&db, json!({"op":"claim","job_id":j["id"]})).unwrap();
        fixtures::call(&db, json!({"op":"fail","job_id":j["id"],"epoch":1,"retryable":false,"error":{"code":"FIXTURE","message":"Synthetic terminal builder"}})).unwrap();
    }
    let mut run = get(&db, "runs", "compare").unwrap();
    run["model_budgets"][0]["requests"] = json!(9);
    run["model_budgets"][0]["charged_microusd"] = json!(1234);
    save(&db, "runs", "compare", &run).unwrap();
    let mut approval = fixtures::approval();
    approval["_comparison_reviewer"] = original["agents"][0].clone();
    approval["_comparison_reviewer_budget"] = fixtures::budget("zai", "glm-5.3-flash");
    let receipt = fixtures::call(&db, approval.clone()).unwrap();
    let after = get(&db, "runs", "compare").unwrap();
    assert_eq!(after["model_budgets"], run["model_budgets"]);
    assert_eq!(
        after["comparison"]["model_budgets"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        after["comparison"]["model_budgets"]
            .as_array()
            .unwrap()
            .iter()
            .all(|b| b["requests"] == 0 && b["charged_microusd"] == 0)
    );
    assert_eq!(fixtures::call(&db, approval).unwrap(), receipt);
}
#[test]
fn legacy_additional_approval_freezes_fresh_policy_without_rewriting_original() {
    let db = fixtures::db();
    let mut input = fixtures::input();
    input.as_object_mut().unwrap().remove("comparison");
    let old = fixtures::call(&db, input).unwrap();
    fixtures::candidate(&db, 1, &"b".repeat(40));
    fixtures::candidate(&db, 2, &"c".repeat(40));
    let mut policy = repo(&db).unwrap()["policy"].clone();
    policy["version"] = json!("compare-v2");
    fixtures::call(&db,json!({"op":"update_policy","policy":policy,"expected_policy":"compare-v1","expected_commit":"a".repeat(40),"expected_version":0})).unwrap();
    for index in 1..=2 {
        let id = format!("candidate-{index}");
        let j = format!("evaluate:{id}:compare-v2");
        let c = get(&db, "candidates", &id).unwrap();
        fixtures::call(&db, json!({"op":"claim","job_id":j})).unwrap();
        fixtures::call(&db,json!({"op":"finish","job_id":j,"epoch":1,"result":{"id":format!("fresh-{index}"),"candidate":id,"revision":c["revision"],"policy":"compare-v2","suite":policy["suite"],"environment":policy["environment"],"evidence":"f".repeat(64),"checks":[{"name":"build","status":"pass","detail":"Fresh stronger policy fixture"}]}})).unwrap();
    }
    let mut approval = fixtures::approval();
    approval["expected_policy_version"] = json!("compare-v2");
    fixtures::call(&db, approval).unwrap();
    let run = get(&db, "runs", "compare").unwrap();
    assert_eq!(run["policy"], old["policy"]);
    assert_eq!(
        run["comparison"]["approval"]["original_policy"],
        old["policy"]
    );
    assert_eq!(
        run["comparison"]["approval"]["policy"]["version"],
        "compare-v2"
    );
    assert!(super::validate(&run).is_ok());
    let job = run_jobs(&db, "compare")
        .unwrap()
        .into_iter()
        .find(|j| j["payload"]["comparison_review"] == true)
        .unwrap();
    assert_eq!(job["payload"]["policy"]["version"], "compare-v2");
}
