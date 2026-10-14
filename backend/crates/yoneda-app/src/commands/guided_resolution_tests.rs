//! Real Native command sequence; Root Git observations are explicit protocol fixtures.
use super::*;
fn call(db: &NativeStore, input: Value, now: i64) -> Value {
    let mut input = input;
    input["now"] = json!(now);
    execute(db, input).unwrap()
}
fn resolved_capture() -> (NativeStore, String) {
    let (db, run, candidate) = stale_capture();
    let cid = candidate["id"].as_str().unwrap();
    evidence_fixture::evaluate(&db, cid, "parallel");
    let view = read(&db);
    let head = view["working_revision"]["commit"].clone();
    let version = view["working_version"].clone();
    let receipt = call(
        &db,
        json!({"op":"refresh_candidate","request_id":"guide-conflict","candidate_id":cid,"expected_commit":head,"expected_version":version}),
        65,
    );
    let refresh = call(&db, json!({"op":"claim","job_id":receipt["job_id"]}), 66);
    let paths = json!(["public/app.mjs", "public/tasks.mjs"]);
    call(
        &db,
        json!({"op":"conflict_refresh_complete","job_id":refresh["id"],"epoch":refresh["epoch"],"result":{
        "status":"unresolved","evidence":{"base_commit":candidate["base"]["commit"],"observed_head":head,"candidate_commit":candidate["revision"]["commit"],"declared_paths":refresh["payload"]["declared_paths"],"captured_paths":paths,"intervening_paths":paths,"overlapping_paths":paths},
        "merge_workspace_commit":"3".repeat(40),"workspace_revision":{"repository":"owner/merge","commit":"3".repeat(40)},"conflict_paths":["public/tasks.mjs"],
        "readback":{"observed_head":head,"version":version,"parents":[head,candidate["revision"]["commit"]],"candidate_paths":paths,"intervening_paths":paths,"workspace_commit":"3".repeat(40),"conflict_paths":["public/tasks.mjs"]}}}),
        67,
    );
    let updated = get(&db, "runs", run["id"].as_str().unwrap()).unwrap();
    let coordinator = call(
        &db,
        json!({"op":"claim","job_id":format!("job:{}",updated["coordinator_execution_id"].as_str().unwrap())}),
        68,
    );
    let resolved = call(
        &db,
        json!({"op":"resolve_conflict","job_id":coordinator["id"],"epoch":coordinator["epoch"],"request_id":"guide-resolve","conflict_id":receipt["conflict_id"],"expected_commit":head,"expected_version":version,"expected_plan_revision":updated["team_plan_revision"],"expected_task_revisions":{"core":1,"integrate":1}}),
        69,
    );
    let resolver = call(&db, json!({"op":"claim","job_id":resolved["job_id"]}), 70);
    call(
        &db,
        json!({"op":"record_transcript","job_id":resolver["id"],"epoch":resolver["epoch"],"digest":"a".repeat(64)}),
        71,
    );
    call(
        &db,
        json!({"op":"finish","job_id":resolver["id"],"epoch":resolver["epoch"],"result":{"git_verified":true,"fork_revision":{"repository":"owner/resolver","commit":"5".repeat(40)}}}),
        72,
    );
    let capture = call(
        &db,
        json!({"op":"claim","job_id":format!("capture:{}",resolved["execution_id"].as_str().unwrap())}),
        73,
    );
    let final_id = "candidate:guide-final";
    call(
        &db,
        json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],"result":{
        "id":final_id,"revision":{"repository":"owner/resolved","commit":"4".repeat(40)},"tree":"f".repeat(40),"paths":paths,"resolver_delta_paths":["public/tasks.mjs"],
        "readback":{"observed_head":head,"version":version,"parents":[head],"candidate_commit":"4".repeat(40),"resolver_delta_paths":["public/tasks.mjs"],"captured_paths":paths}}}),
        74,
    );
    (db, final_id.to_owned())
}
#[test]
fn guided_resolver_capture_freezes_final_check_before_evaluator_claim() {
    let (db, cid) = resolved_capture();
    let job = get(&db, "jobs", &format!("evaluate:{cid}")).unwrap();
    assert_eq!(job["payload"]["guided"]["check_phase"], "final");
    assert!(job["payload"]["guided"].get("variant").is_none());
    let mut reported = job.clone();
    reported["payload"]["guided"]["check_phase"] = json!("parallel");
    assert!(
        crate::commands::guided::validate_report(
            &job,
            &json!({"guided_check_phase":"parallel","guided_check_variant":"sort"})
        )
        .is_err()
    );
}
#[test]
fn guided_final_scope_check_allows_explicit_owner_publication_and_only_readback_completes() {
    let (db, cid) = resolved_capture();
    evidence_fixture::evaluate(&db, &cid, "final");
    let before = read(&db);
    assert_eq!(before["steps"][2]["status"], "complete");
    assert_ne!(before["steps"][3]["status"], "complete");
    let approved = call(
        &db,
        json!({"op":"accept","request_id":"guide-publish","candidate":cid,"expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Owner reviewed final checked source"}),
        80,
    );
    let job = all(&db, "jobs")
        .unwrap()
        .into_iter()
        .find(|j| j["kind"] == "publish")
        .unwrap();
    let claimed = call(&db, json!({"op":"claim","job_id":job["id"]}), 81);
    call(
        &db,
        json!({"op":"finish","job_id":claimed["id"],"epoch":claimed["epoch"],"result":{"commit":"4".repeat(40)}}),
        82,
    );
    assert_eq!(
        get(&db, "decisions", approved["id"].as_str().unwrap()).unwrap()["status"],
        "published"
    );
    assert_eq!(read(&db)["steps"][3]["status"], "complete");
}

#[test]
fn guided_final_candidate_without_trusted_overlap_cannot_complete_collaboration() {
    let (db, cid) = resolved_capture();
    evidence_fixture::evaluate(&db, &cid, "final");
    assert_eq!(read(&db)["steps"][2]["status"], "complete");
    let mut conflict = get(&db, "conflicts", "conflict:guide-conflict").unwrap();
    conflict["evidence"]["overlapping_paths"] = json!([]);
    save(&db, "conflicts", "conflict:guide-conflict", &conflict).unwrap();
    assert_ne!(read(&db)["steps"][2]["status"], "complete");
}

#[test]
fn guided_registered_clean_refresh_gets_final_checks_without_claiming_conflict_resolution() {
    let (db, _, candidate) = stale_capture();
    evidence_fixture::evaluate(&db, candidate["id"].as_str().unwrap(), "parallel");
    let view = read(&db);
    let head = view["working_revision"]["commit"].clone();
    let version = view["working_version"].clone();
    let receipt = call(
        &db,
        json!({"op":"refresh_candidate","request_id":"clean-guide-refresh","candidate_id":candidate["id"],"expected_commit":head,"expected_version":version}),
        65,
    );
    let job = call(&db, json!({"op":"claim","job_id":receipt["job_id"]}), 66);
    let paths = json!(["public/app.mjs", "public/tasks.mjs"]);
    let cid = format!("candidate:refresh:{}", "6".repeat(40));
    call(
        &db,
        json!({"op":"conflict_refresh_complete","job_id":job["id"],"epoch":job["epoch"],"result":{
        "status":"clean","candidate_id":cid,"revision":{"repository":"owner/refreshed","commit":"6".repeat(40)},"tree":"f".repeat(40),"merge_commit":"6".repeat(40),"paths":paths,"diff_digest":"d".repeat(64),
        "evidence":{"base_commit":candidate["base"]["commit"],"observed_head":head,"candidate_commit":candidate["revision"]["commit"],"declared_paths":job["payload"]["declared_paths"],"captured_paths":paths,"intervening_paths":paths,"overlapping_paths":paths},
        "readback":{"observed_head":head,"version":version,"parents":[head,candidate["revision"]["commit"]],"candidate_paths":paths,"intervening_paths":paths,"merge_commit":"6".repeat(40),"merged_paths":paths}}}),
        67,
    );
    let evaluator = get(&db, "jobs", &format!("evaluate:{cid}")).unwrap();
    assert_eq!(evaluator["payload"]["guided"]["check_phase"], "final");
    assert!(evaluator["payload"]["guided"].get("variant").is_none());
    evidence_fixture::evaluate(&db, &cid, "final");
    assert_ne!(read(&db)["steps"][2]["status"], "complete");
    let before = execute(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(execute(&db,json!({"op":"accept","request_id":"no-resolution-publication","candidate":cid,"expected_commit":"a".repeat(40),"expected_version":0,"rationale":"A clean merge alone is not collaboration resolution","now":80})).unwrap_err().code,"GUIDED_NOT_PUBLISHABLE");
    assert_eq!(execute(&db, json!({"op":"snapshot"})).unwrap(), before);
}

#[test]
fn guided_publication_leases_canonical_root_not_the_working_base() {
    let (db, cid) = resolved_capture();
    evidence_fixture::evaluate(&db, &cid, "final");
    let candidate = get(&db, "candidates", &cid).unwrap();
    assert_ne!(candidate["base"]["commit"], "a".repeat(40));
    call(
        &db,
        json!({"op":"accept","request_id":"guide-lease","candidate":cid,"expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Owner reviewed final checked source"}),
        80,
    );
    let job = get(&db, "jobs", "publish:decision:guide-lease").unwrap();
    assert_eq!(job["payload"]["expected"]["commit"], "a".repeat(40));
}

#[test]
fn guided_rejected_final_result_makes_concurrent_retryable_from_extend_checkpoint() {
    let (db, cid) = resolved_capture();
    evidence_fixture::evaluate(&db, &cid, "final");
    let before = read(&db);
    assert_eq!(before["steps"][2]["status"], "complete");
    let extend = before["steps"][1]["revision"].clone();
    let rejected = call(
        &db,
        json!({"op":"reject_candidate","request_id":"guide-reject","candidate":cid,"expected_commit":"a".repeat(40),"expected_version":0,"reason":"Sorting drops filtered tasks"}),
        80,
    );
    assert_eq!(rejected["status"], "rejected");
    let view = read(&db);
    assert_eq!(view["steps"][2]["status"], "needs_attention");
    assert_eq!(view["steps"][3]["status"], "locked");
    assert!(
        view["steps"][2]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "owner_rejection" && e["decision_id"] == rejected["id"])
    );
    // The fixture leaves its claimed coordinator running; settle it as hosted work would.
    for mut j in all(&db, "jobs").unwrap() {
        if j["status"] == "queued" || j["status"] == "running" {
            j["status"] = json!("done");
            save(&db, "jobs", j["id"].as_str().unwrap(), &j).unwrap();
        }
    }
    let previous = view["steps"][2]["run_ids"].clone();
    let mut retry = request("concurrent");
    retry["request_id"] = json!("retry-after-reject");
    retry["retry"] = json!(true);
    retry["expected_commit"] = view["working_revision"]["commit"].clone();
    retry["expected_version"] = view["working_version"].clone();
    retry["_guided_runs"] = json!([prepared(), prepared()]);
    retry["now"] = json!(90);
    let retried = execute(&db, retry).unwrap();
    assert_eq!(retried["steps"][2]["status"], "running");
    assert_eq!(retried["steps"][2]["previous_run_ids"], previous);
    assert_eq!(retried["working_revision"], extend);
    for id in retried["steps"][2]["run_ids"].as_array().unwrap() {
        let run = get(&db, "runs", id.as_str().unwrap()).unwrap();
        assert_eq!(
            run["base"], extend,
            "retry forks from the extend checkpoint"
        );
    }
    // Earlier decisions and the rejected result remain as immutable history.
    assert_eq!(
        get(&db, "decisions", rejected["id"].as_str().unwrap()).unwrap()["status"],
        "rejected"
    );
    assert!(get(&db, "candidates", &cid).is_ok());
    assert_eq!(retried["steps"][1]["status"], "complete");
}
