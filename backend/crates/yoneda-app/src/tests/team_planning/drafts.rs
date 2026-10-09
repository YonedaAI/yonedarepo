use super::*;

fn changed(label: &str) -> Value {
    let mut plan = proposed(1);
    plan["contract"] = json!(label);
    plan
}
fn revise(plan: Value, epoch: i64, expected: &Value) -> Value {
    let mut command = proposal(plan, epoch);
    command["expected_proposal"] = expected.clone();
    command
}
fn context(db: &NativeStore, epoch: i64) -> Value {
    call(
        db,
        json!({"op":"team_context","job_id":"job:auto:planner","epoch":epoch}),
    )
    .unwrap()
}

#[test]
fn team_planner_drafts_use_cas_and_older_replays_never_rewind_the_active_draft() {
    let db = setup(1);
    claim(&db);
    assert!(context(&db, 1)["active_proposal"].is_null());
    let first = call(&db, proposal(proposed(1), 1)).unwrap();
    let second_plan = changed("Implement the full accessible event journey");
    let second = call(&db, revise(second_plan.clone(), 1, &first["id"])).unwrap();
    assert_ne!(first["id"], second["id"]);
    assert_eq!(second["data"]["draft_revision"], 2);
    let active = context(&db, 1);
    assert_eq!(active["active_proposal_id"], second["id"]);
    assert_eq!(active["active_proposal"], second);
    assert_eq!(active["proposal_versions"], 2);
    assert_eq!(active["max_proposal_versions"], 8);
    assert_eq!(snapshot(&db)["team_tasks"], json!([]));
    let events = call(&db, json!({"op":"events","after":0})).unwrap();
    assert_eq!(call(&db, proposal(proposed(1), 1)).unwrap(), first);
    assert_eq!(
        context(&db, 1),
        active,
        "older duplicate cannot select its draft again"
    );
    assert_eq!(call(&db, json!({"op":"events","after":0})).unwrap(), events);
    assert_eq!(
        call(&db, revise(changed("Third draft"), 1, &first["id"]))
            .unwrap_err()
            .code,
        "STALE_PROPOSAL"
    );
    assert_eq!(
        call(&db, proposal(changed("Missing expected pointer"), 1))
            .unwrap_err()
            .code,
        "IDEMPOTENCY_CONFLICT"
    );
    assert_eq!(
        context(&db, 1),
        active,
        "failed CAS leaves the pointer and drafts intact"
    );
    call(&db, finish(1)).unwrap();
    assert_eq!(snapshot(&db)["runs"][0]["team_plan"], second_plan);
    assert_eq!(snapshot(&db)["runs"][0]["team_plan_proposal"], second["id"]);
}

#[test]
fn team_planner_draft_bound_counts_unique_versions_and_resets_for_a_new_attempt() {
    let db = setup(1);
    claim(&db);
    let first = call(&db, proposal(changed("Draft 1"), 1)).unwrap();
    let mut latest = first.clone();
    for version in 2..=8 {
        latest = call(
            &db,
            revise(changed(&format!("Draft {version}")), 1, &latest["id"]),
        )
        .unwrap();
        assert_eq!(latest["data"]["draft_revision"], version);
    }
    let before = snapshot(&db);
    assert_eq!(
        call(&db, revise(changed("Draft 9"), 1, &latest["id"]))
            .unwrap_err()
            .code,
        "TEAM_PLAN_DRAFT_LIMIT"
    );
    assert_eq!(
        snapshot(&db),
        before,
        "draft limit rolls back all durable writes"
    );
    assert_eq!(call(&db, proposal(changed("Draft 1"), 1)).unwrap(), first);
    assert_eq!(context(&db, 1)["active_proposal_id"], latest["id"]);
    call(&db,json!({"op":"fail","job_id":"job:auto:planner","epoch":1,"error":"Simulated planner interruption","retryable":true})).unwrap();
    assert_eq!(claim(&db)["epoch"], 2);
    let fresh = context(&db, 2);
    assert!(fresh["active_proposal"].is_null());
    assert_eq!(fresh["proposal_versions"], 0);
    assert_eq!(call(&db, finish(2)).unwrap_err().code, "MISSING_TEAM_PLAN");
    let retry = call(&db, proposal(changed("Draft 1"), 2)).unwrap();
    assert_ne!(retry["id"], first["id"]);
    assert_eq!(retry["data"]["draft_revision"], 1);
    assert_eq!(context(&db, 2)["active_proposal_id"], retry["id"]);
    call(&db, finish(2)).unwrap();
    assert_eq!(snapshot(&db)["runs"][0]["team_plan_proposal"], retry["id"]);
}

#[test]
fn team_planner_completion_rejects_a_forged_active_draft_without_dispatching_source_tasks() {
    for field in [
        "job_id",
        "execution_id",
        "run_id",
        "epoch",
        "author",
        "kind",
        "authority",
        "fingerprint",
        "plan",
    ] {
        let db = setup(1);
        claim(&db);
        let mut draft = call(&db, proposal(proposed(1), 1)).unwrap();
        let id = draft["id"].as_str().unwrap().to_owned();
        match field {
            "author" | "kind" => draft[field] = json!("forged"),
            "epoch" => draft["data"][field] = json!(2),
            "plan" => {
                draft["data"]["plan"] = changed("Forged source plan");
                draft["data"]["fingerprint"] =
                    json!(yoneda_core::fingerprint(&draft["data"]["plan"]).unwrap());
            }
            _ => draft["data"][field] = json!("forged"),
        }
        crate::storage::save(&db, "nodes", &id, &draft).unwrap();
        assert_eq!(call(&db, finish(1)).unwrap_err().code, "FENCED", "{field}");
        let s = snapshot(&db);
        assert_eq!(s["runs"][0]["status"], "planning", "{field}");
        assert!(s["runs"][0].get("team_plan").is_none(), "{field}");
        assert_eq!(s["team_tasks"], json!([]), "{field}");
        assert_eq!(s["executions"].as_array().unwrap().len(), 1, "{field}");
    }
}
