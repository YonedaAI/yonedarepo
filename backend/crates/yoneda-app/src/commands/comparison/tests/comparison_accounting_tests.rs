use super::*;

fn finish_held_builder(db: &NativeStore, job: &Value) {
    f::call(
        db,
        json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],
        "result":{"workspace":"e".repeat(64)}}),
    )
    .unwrap();
    f::call(db, json!({"op":"claim","job_id":"capture:compare:agent-1"})).unwrap();
    let revision = json!({"repository":"test/fork","commit":"b".repeat(40)});
    f::call(
        db,
        json!({"op":"finish","job_id":"capture:compare:agent-1","epoch":1,
        "result":{"id":"candidate-1","revision":revision,"tree":"f".repeat(40),
            "paths":["src/booking.rs"],"summary":"Synthetic checked booking implementation"}}),
    )
    .unwrap();
    f::call(db, json!({"op":"claim","job_id":"evaluate:candidate-1"})).unwrap();
    let policy = repo(db).unwrap()["policy"].clone();
    f::call(db, json!({"op":"finish","job_id":"evaluate:candidate-1","epoch":1,
        "result":{"id":"evaluation-candidate-1","candidate":"candidate-1","revision":revision,
            "policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],
            "evidence":"e".repeat(64),"checks":[{"name":"build","status":"pass","detail":"Synthetic evaluator observations"}]}})).unwrap();
}

#[test]
fn exhausted_legacy_aggregate_and_group_do_not_consume_fresh_explicit_approval_segment() {
    let db = db();
    let mut old = input();
    old.as_object_mut().unwrap().remove("comparison");
    f::call(&db, old.clone()).unwrap();
    let builder = f::call(&db, json!({"op":"claim","job_id":"job:compare:agent-1"})).unwrap();
    // Exhaust the original 144-request aggregate and model group through actual
    // reservations, retaining unknown usage rather than fabricating counters.
    for _ in 0..144 {
        reserve(&db, &builder).unwrap();
    }
    assert!(reserve(&db, &builder).is_err());
    finish_held_builder(&db, &builder);
    f::candidate(&db, 2, &"c".repeat(40));
    let before = get(&db, "runs", "compare").unwrap();
    let old_jobs = run_jobs(&db, "compare").unwrap();
    assert_eq!(before["model_budgets"][0]["requests"], 144);
    assert!(
        before["model_budgets"][0]["charged_microusd"]
            .as_i64()
            .unwrap()
            > 0
    );

    let mut approval = f::approval();
    approval["_comparison_reviewer"] = old["_comparison_reviewer"].clone();
    approval["_comparison_reviewer_budget"] = old["_comparison_reviewer_budget"].clone();
    approval["expected_working_commit"] = json!("a".repeat(40));
    approval["expected_working_version"] = json!(0);
    let receipt = f::call(&db, approval.clone()).unwrap();
    let review = reviewer(&db);
    let reservation = reserve(&db, &review).unwrap();
    let settlement = json!({"op":"settle_model_request","job_id":review["id"],"epoch":review["epoch"],
        "reservation_id":reservation["reservation_id"],"input_tokens":10,"output_tokens":1});
    let settled = f::call(&db, settlement.clone()).unwrap();
    assert_eq!(f::call(&db, settlement).unwrap(), settled);
    assert_eq!(f::call(&db, approval).unwrap(), receipt);
    assert!(reserve(&db, &builder).is_err());
    let after = get(&db, "runs", "compare").unwrap();
    assert_eq!(after["model_budgets"], before["model_budgets"]);
    assert_eq!(after["agents"], before["agents"]);
    for original in old_jobs {
        assert_eq!(
            get(&db, "jobs", original["id"].as_str().unwrap()).unwrap(),
            original
        );
    }
    assert_eq!(
        after["comparison"]["model_budgets"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let fresh = after["comparison"]["model_budgets"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["provider"] == "zai")
        .unwrap();
    assert_eq!(fresh["requests"], 1);
    assert_eq!(fresh["charged_microusd"], settled["charged_microusd"]);
}

#[test]
fn separate_glm_reviewer_has_twelve_requests_each_round_and_no_third_repair() {
    let db = db();
    let mut c = input();
    c["agents"] = json!([
        {"provider":"codex","model":"gpt-6-sol","connection":"sol","strategy":"minimal"},
        {"provider":"claude","model":"claude-sonnet-5-5","connection":"sonnet","strategy":"defensive"}
    ]);
    let mut review_budget = f::budget("zai", "glm-5.3-flash");
    review_budget["max_requests"] = json!(36);
    c["_comparison_reviewer_budget"] = review_budget.clone();
    c["model_budgets"] = json!([
        f::budget("codex", "gpt-6-sol"),
        f::budget("claude", "claude-sonnet-5-5"),
        review_budget
    ]);
    f::call(&db, c).unwrap();
    f::candidate(&db, 1, &"b".repeat(40));
    f::candidate(&db, 2, &"c".repeat(40));
    for round in 0..3 {
        let job = reviewer(&db);
        let context = f::call(
            &db,
            json!({"op":"comparison_context","job_id":job["id"],"epoch":job["epoch"]}),
        )
        .unwrap();
        for _ in 0..12 {
            reserve(&db, &job).unwrap();
        }
        assert!(reserve(&db, &job).is_err());
        let mut request = submit(
            &job,
            &context,
            if round < 2 {
                "repair_requested"
            } else {
                "selected"
            },
        );
        request["request_id"] = json!(format!("review-round-{round}"));
        if round == 2 {
            let mut third = request.clone();
            third["outcome"] = json!("repair_requested");
            assert!(f::call(&db, third).is_err());
        }
        f::call(&db, request).unwrap();
        complete(&db, &job, true).unwrap();
        if round < 2 {
            let repair = run_jobs(&db, "compare")
                .unwrap()
                .into_iter()
                .find(|j| {
                    j["payload"]["execution"]["comparison_role"] == "repair"
                        && j["status"] == "queued"
                })
                .unwrap();
            f::finish_candidate(
                &db,
                repair["payload"]["execution"]["id"].as_str().unwrap(),
                &format!("repair-candidate-{round}"),
                &if round == 0 { "d" } else { "e" }.repeat(40),
            );
        }
    }
    let run = get(&db, "runs", "compare").unwrap();
    assert_eq!(
        run["comparison"]["review_requests_by_round"],
        json!([12, 12, 12])
    );
    assert_eq!(run["execution_count"], 7);
    assert_eq!(
        get(&db, "working_branches", "development").unwrap()["version"],
        1
    );
    assert_eq!(repo(&db).unwrap()["published_commit"], "a".repeat(40));
}
