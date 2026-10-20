use super::fixtures as f;
use crate::storage::{get, repo, run_jobs};
use serde_json::json;

#[test]
fn legacy_one_three_and_six_builder_rosters_require_deliberate_checked_selection() {
    for count in [1, 3, 6] {
        let db = f::db();
        f::call(
            &db,
            json!({"op":"create_working_branch","id":"development",
            "expected_commit":"a".repeat(40),"expected_version":0}),
        )
        .unwrap();
        let agents: Vec<_> = (1..=count)
            .map(|index| {
                json!({"provider":"zai",
            "model":"glm-5.3-flash","strategy":format!("approach-{index}")})
            })
            .collect();
        let run = f::call(
            &db,
            json!({"op":"start_run","id":"compare","mode":"compare",
            "intent":"Deliberately compare historical supported approaches",
            "agents":agents,"model_budgets":[f::budget("zai","glm-5.3-flash")],
            "working_branch_id":"development","expected_working_commit":"a".repeat(40),
            "expected_working_version":0}),
        )
        .unwrap();
        assert!(run["comparison"].is_null());
        f::candidate(&db, 1, &"b".repeat(40));
        assert_eq!(
            get(&db, "working_branches", "development").unwrap()["version"],
            0,
            "The first checked candidate cannot implicitly select a legacy {count}-builder roster"
        );
        let choice = json!({"op":"select_comparison_candidate","run_id":"compare",
            "request_id":format!("legacy-choice-{count}"),"candidate_id":format!("candidate-{count}"),
            "reason":"Owner prefers this independently checked approach after comparing the available alternatives",
            "expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_version":"compare-v1",
            "expected_working_commit":"a".repeat(40),"expected_working_version":0,"expected_selection_version":0});
        if count > 1 {
            let mut premature = choice.clone();
            premature["candidate_id"] = json!("candidate-1");
            let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
            assert!(f::call(&db, premature).is_err());
            assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
        }
        for index in 2..=count {
            f::candidate(&db, index, &format!("{index:x}").repeat(40));
            assert_eq!(
                get(&db, "working_branches", "development").unwrap()["version"],
                0
            );
        }
        let receipt = f::call(&db,choice.clone()).unwrap_or_else(|error|
            panic!("A terminal legacy {count}-builder roster must permit deliberate selection: {error:?}"));
        assert_eq!(
            receipt["comparison"]["selected_candidate_id"],
            format!("candidate-{count}")
        );
        assert_eq!(receipt["working_branch"]["version"], 1);
        assert_eq!(f::call(&db, choice).unwrap(), receipt);
        assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
        assert!(get(&db, "runs", "compare").unwrap()["comparison"]["approval"].is_null());
        assert_eq!(
            run_jobs(&db, "compare")
                .unwrap()
                .iter()
                .filter(|j| j["kind"] == "agent")
                .count(),
            count
        );
    }
}

#[test]
fn legacy_three_builder_choice_requires_current_policy_checks_of_the_exact_capture() {
    let db = f::db();
    f::call(
        &db,
        json!({"op":"create_working_branch","id":"development",
        "expected_commit":"a".repeat(40),"expected_version":0}),
    )
    .unwrap();
    let agents: Vec<_> = (1..=3)
        .map(|index| {
            json!({"provider":"zai","model":"glm-5.3-flash",
        "strategy":format!("approach-{index}")})
        })
        .collect();
    f::call(&db,json!({"op":"start_run","id":"compare","mode":"compare","intent":"Legacy checked selection",
        "agents":agents,"model_budgets":[f::budget("zai","glm-5.3-flash")],
        "working_branch_id":"development","expected_working_commit":"a".repeat(40),"expected_working_version":0})).unwrap();
    for index in 1..=3 {
        f::candidate(&db, index, &format!("{index:x}").repeat(40));
    }
    let captured = get(&db, "candidates", "candidate-3").unwrap()["revision"].clone();
    let mut policy = repo(&db).unwrap()["policy"].clone();
    policy["version"] = json!("compare-v2");
    f::call(
        &db,
        json!({"op":"update_policy","policy":policy,"expected_commit":"a".repeat(40),
        "expected_version":0,"expected_policy":"compare-v1"}),
    )
    .unwrap();
    let choice = json!({"op":"select_comparison_candidate","run_id":"compare","request_id":"fresh-legacy-choice",
        "candidate_id":"candidate-3","reason":"Owner chooses the exact capture after its current-policy checks",
        "expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_version":"compare-v2",
        "expected_working_commit":"a".repeat(40),"expected_working_version":0,"expected_selection_version":0});
    let before = f::call(&db, json!({"op":"snapshot"})).unwrap();
    assert!(f::call(&db, choice.clone()).is_err());
    assert_eq!(f::call(&db, json!({"op":"snapshot"})).unwrap(), before);
    for index in 1..=3 {
        let candidate = get(&db, "candidates", &format!("candidate-{index}")).unwrap();
        let job = f::call(
            &db,
            json!({"op":"claim","job_id":format!("evaluate:candidate-{index}:compare-v2")}),
        )
        .unwrap();
        f::call(&db,json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],"result":{
            "id":format!("fresh-evaluation-{index}"),"candidate":candidate["id"],"revision":candidate["revision"],
            "policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],
            "evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"Synthetic current-policy evaluator observations"}]}})).unwrap();
    }
    let receipt = f::call(&db, choice).unwrap();
    assert_eq!(receipt["working_branch"]["working_revision"], captured);
    assert_eq!(receipt["working_branch"]["version"], 1);
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
}

#[test]
fn legacy_manual_choice_accepts_a_checked_delegate_with_original_approved_lineage() {
    let db = f::db();
    f::call(
        &db,
        json!({"op":"create_working_branch","id":"development",
        "expected_commit":"a".repeat(40),"expected_version":0}),
    )
    .unwrap();
    let agents: Vec<_> = (1..=3)
        .map(|index| {
            json!({"provider":"zai","model":"glm-5.3-flash",
        "strategy":format!("approach-{index}")})
        })
        .collect();
    f::call(&db,json!({"op":"start_run","id":"compare","mode":"compare","intent":"Legacy bounded delegation",
        "agents":agents,"model_budgets":[f::budget("zai","glm-5.3-flash")],
        "delegation":{"enabled":true,"max_depth":1,"max_executions":4},
        "working_branch_id":"development","expected_working_commit":"a".repeat(40),"expected_working_version":0})).unwrap();
    let parent = f::call(&db, json!({"op":"claim","job_id":"job:compare:agent-1"})).unwrap();
    let delegate = f::call(
        &db,
        json!({"op":"delegate_agent","job_id":parent["id"],"epoch":parent["epoch"],
        "request_id":"bounded-child","task":"Produce a safe independent booking implementation",
        "strategy":"transaction boundaries"}),
    )
    .unwrap();
    let id = delegate["execution"]["id"].as_str().unwrap();
    // A completed parent retains the same epoch and permits its issued delegate
    // to finish. Failed parents correctly fence descendants and are not a valid
    // positive fixture for deliberate selection.
    let registration = crate::commands::source_kit::finish_agent(&db, &parent, 1000);
    f::call(
        &db,
        json!({"op":"claim","job_id":"capture:compare:agent-1"}),
    )
    .unwrap();
    let revision = json!({"repository":"test/fork","commit":"e".repeat(40)});
    f::call(
        &db,
        json!({"op":"finish","job_id":"capture:compare:agent-1","epoch":1,"result":crate::commands::source_kit::with_lineage(&registration,json!({
        "id":"candidate-1","revision":revision,"tree":"f".repeat(40),"paths":["src/booking.rs"],
        "summary":"Synthetic checked parent capture"}))}),
    )
    .unwrap();
    f::call(&db, json!({"op":"claim","job_id":"evaluate:candidate-1"})).unwrap();
    let policy = repo(&db).unwrap()["policy"].clone();
    f::call(&db,json!({"op":"finish","job_id":"evaluate:candidate-1","epoch":1,"result":{
        "id":"evaluation-candidate-1","candidate":"candidate-1","revision":revision,
        "policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],
        "evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"Synthetic parent evaluator observations"}]}})).unwrap();
    f::finish_candidate(&db, id, "checked-delegate", &"d".repeat(40));
    f::candidate(&db, 2, &"b".repeat(40));
    f::candidate(&db, 3, &"c".repeat(40));
    let receipt = f::call(&db,json!({"op":"select_comparison_candidate","run_id":"compare",
        "request_id":"delegate-choice","candidate_id":"checked-delegate",
        "reason":"Owner selects the independently checked delegate issued by the original bounded approval",
        "expected_commit":"a".repeat(40),"expected_version":0,"expected_policy_version":"compare-v1",
        "expected_working_commit":"a".repeat(40),"expected_working_version":0,"expected_selection_version":0})).unwrap();
    assert_eq!(receipt["working_branch"]["working_commit"], "d".repeat(40));
    assert_eq!(receipt["working_branch"]["version"], 1);
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
    assert_eq!(get(&db, "runs", "compare").unwrap()["execution_count"], 4);
}
