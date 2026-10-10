use super::refresh::{complete, refresh};
use super::*;
use super::{inventory::status, resolver::resolve};
use crate::{execute, native::NativeStore};

fn setup() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(&db, json!({"op":"init","now":1,"id":"conflict-repo","name":"Conflict","remote":{"namespace":"test","name":"conflict"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default()})).unwrap();
    for statement in include_str!("../../migrations/0010_conflicts.sql").split(';') {
        if !statement.trim().is_empty() {
            db.query(statement, &[]).unwrap();
        }
    }
    let mut repository = repo(&db).unwrap();
    repository["head_commit"] = json!("b".repeat(40));
    repository["published_commit"] = json!("b".repeat(40));
    repository["version"] = json!(1);
    save(&db, "repository", "repo", &repository).unwrap();
    create(&db,"runs","run",&json!({"id":"run","mode":"compare","status":"exploring","base":{"repository":"test/conflict","commit":"a".repeat(40)}})).unwrap();
    create(
        &db,
        "executions",
        "execution",
        &json!({"id":"execution","run_id":"run","status":"completed"}),
    )
    .unwrap();
    create(&db,"candidates","candidate",&json!({"id":"candidate","run_id":"run","execution":"execution","base":{"repository":"test/conflict","commit":"a".repeat(40)},"revision":{"repository":"fork/conflict","commit":"c".repeat(40)},"status":"eligible","paths":["src/change.rs"],"declared_paths":["src/change.rs"],"evaluation":"evaluation"})).unwrap();
    create(&db,"candidates","another-candidate",&json!({"id":"another-candidate","run_id":"run","execution":"execution","base":{"repository":"test/conflict","commit":"a".repeat(40)},"revision":{"repository":"fork/conflict","commit":"d".repeat(40)},"status":"eligible","paths":["src/other.rs"],"declared_paths":["src/other.rs"],"evaluation":"evaluation"})).unwrap();
    db
}
fn request() -> Value {
    json!({"op":"refresh_candidate","request_id":"refresh-1","candidate_id":"candidate","expected_version":1,"expected_commit":"b".repeat(40)})
}
fn evidence() -> Value {
    json!({"base_commit":"a".repeat(40),"observed_head":"b".repeat(40),"candidate_commit":"c".repeat(40),"declared_paths":["src/change.rs"],"captured_paths":["src/change.rs"],"intervening_paths":["README.md"],"overlapping_paths":[]})
}

#[test]
fn conflict_migration_is_repeatable_and_indexes_request_identity() {
    let db = NativeStore::memory().unwrap();
    let migration = include_str!("../../migrations/0010_conflicts.sql");
    for _ in 0..2 {
        for statement in migration.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
    }
    let indexes = db.query("PRAGMA index_list(conflicts)", &[]).unwrap();
    let names: Vec<_> = indexes
        .iter()
        .filter_map(|row| row["name"].as_str())
        .collect();
    assert!(names.contains(&"conflicts_request_id"));
    assert!(names.contains(&"conflicts_candidate_id"));
}

#[test]
fn refresh_request_replay_is_stable_and_forged_owner_authority_is_rejected() {
    let db = setup();
    let receipt = refresh(&db, &request(), 2).unwrap();
    assert_eq!(refresh(&db, &request(), 3).unwrap(), receipt);
    let mut forged = request();
    forged["_grant"] = json!("external-agent");
    assert_eq!(refresh(&db, &forged, 4).unwrap_err().code, "FORBIDDEN");
    let mut reviewer = request();
    reviewer["_reviewer"] = json!(true);
    assert_eq!(refresh(&db, &reviewer, 4).unwrap_err().code, "FORBIDDEN");
    let mut changed = request();
    changed["candidate_id"] = json!("another-candidate");
    assert_eq!(
        refresh(&db, &changed, 5).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
}

#[test]
fn second_head_move_stales_and_fences_refresh_result() {
    let db = setup();
    let receipt = refresh(&db, &request(), 2).unwrap();
    let job_id = receipt["job_id"].as_str().unwrap();
    let leased = execute(&db, json!({"op":"claim","job_id":job_id,"now":3})).unwrap();
    let mut repository = repo(&db).unwrap();
    repository["head_commit"] = json!("d".repeat(40));
    repository["version"] = json!(2);
    save(&db, "repository", "repo", &repository).unwrap();
    let result = complete(&db,&json!({"job_id":job_id,"epoch":leased["epoch"],"result":{"status":"clean","evidence":evidence(),"candidate_id":"new","revision":{"repository":"fork/conflict","commit":"e".repeat(40)},"tree":"f".repeat(40),"merge_commit":"e".repeat(40)}}),4).unwrap();
    assert_eq!(result["status"], "stale");
    assert!(get(&db, "candidates", "new").is_err());
}

#[test]
fn trusted_remote_only_head_move_completes_refresh_as_stale() {
    let db = setup();
    let receipt = refresh(&db, &request(), 2).unwrap();
    let job_id = receipt["job_id"].as_str().unwrap();
    let leased = execute(&db, json!({"op":"claim","job_id":job_id,"now":3})).unwrap();
    let result = complete(
        &db,
        &json!({"job_id":job_id,"epoch":leased["epoch"],"now":4,"result":{
            "readback":{"observed_head":"d".repeat(40),"version":1}
        }}),
        4,
    )
    .unwrap();

    assert_eq!(result["status"], "stale");
    assert_eq!(result["reason"], "REMOTE_CHANGE");
    assert_eq!(result["observed_remote_head"], "d".repeat(40));
    assert_eq!(get(&db, "jobs", job_id).unwrap()["status"], "done");
    let conflict = get(&db, "conflicts", receipt["conflict_id"].as_str().unwrap()).unwrap();
    assert_eq!(conflict["status"], "stale");
    assert_eq!(conflict["stale_reason"], "REMOTE_CHANGE");
    assert_eq!(all(&db, "candidates").unwrap().len(), 2);
}

#[test]
fn caller_claim_cannot_authorize_remote_head_staleness_without_frozen_git_transport() {
    let db = setup();
    let receipt = refresh(&db, &request(), 2).unwrap();
    let job_id = receipt["job_id"].as_str().unwrap();
    let leased = execute(&db, json!({"op":"claim","job_id":job_id,"now":3})).unwrap();
    let mut job = get(&db, "jobs", job_id).unwrap();
    job["payload"]
        .as_object_mut()
        .unwrap()
        .remove("workspace_transport");
    save(&db, "jobs", job_id, &job).unwrap();
    let before = get(&db, "conflicts", receipt["conflict_id"].as_str().unwrap()).unwrap();
    let error = complete(
        &db,
        &json!({"job_id":job_id,"epoch":leased["epoch"],"now":4,"result":{
            "git_verified":true,
            "readback":{"observed_head":"d".repeat(40),"version":1}
        }}),
        4,
    )
    .unwrap_err();

    assert_eq!(error.code, "FORBIDDEN");
    assert_eq!(get(&db, "jobs", job_id).unwrap()["status"], "running");
    assert_eq!(
        get(&db, "conflicts", receipt["conflict_id"].as_str().unwrap()).unwrap(),
        before
    );
}

#[test]
fn malformed_remote_head_readback_does_not_terminalize_refresh() {
    let db = setup();
    let receipt = refresh(&db, &request(), 2).unwrap();
    let job_id = receipt["job_id"].as_str().unwrap();
    let leased = execute(&db, json!({"op":"claim","job_id":job_id,"now":3})).unwrap();
    assert!(
        complete(
            &db,
            &json!({"job_id":job_id,"epoch":leased["epoch"],"now":4,"result":{
                "readback":{"observed_head":"not-a-git-hash","version":1}
            }}),
            4,
        )
        .is_err()
    );
    assert_eq!(get(&db, "jobs", job_id).unwrap()["status"], "running");
    assert_eq!(
        get(&db, "conflicts", receipt["conflict_id"].as_str().unwrap()).unwrap()["status"],
        "refreshing"
    );
}

#[test]
fn inventory_includes_stale_candidates_without_a_conflict_id() {
    let db = setup();
    let inventory = status(&db, &json!({"op":"conflict_status"})).unwrap();
    assert_eq!(inventory["head_commit"], "b".repeat(40));
    assert_eq!(inventory["version"], 1);
    assert_eq!(inventory["conflicts"][0]["kind"], "stale_candidate");
    assert_eq!(
        inventory["conflicts"][0]["candidate_id"],
        "another-candidate"
    );
    assert!(inventory.get("stale_candidates").is_none());
    assert_eq!(inventory["overlaps"][0]["status"], "not_analyzed");
    assert_eq!(
        inventory["overlaps"][0]["candidate_id"],
        "another-candidate"
    );
}

#[test]
fn resolver_is_a_scoped_agent_on_the_original_model_budget() {
    let db = setup();
    let mut execution = get(&db, "executions", "execution").unwrap();
    execution["harness"] = json!("claude");
    execution["provider"] = json!("mimo");
    execution["model"] = json!("mimo-v2.6-flash");
    execution["context"] = json!([]);
    execution["budget"] = json!({"provider":"mimo","model":"mimo-v2.6-flash"});
    execution["team_role"] = json!("worker");
    save_execution(&db, &execution, 2).unwrap();
    let candidate = get(&db, "candidates", "candidate").unwrap();
    create(&db,"conflicts","conflict:unresolved",&json!({"id":"conflict:unresolved","repository_id":"conflict-repo","request_id":"refresh-1","candidate_id":"candidate","candidate":candidate,"candidate_revision":"c".repeat(40),"candidate_base":"a".repeat(40),"expected_version":1,"head_commit":"b".repeat(40),"status":"unresolved","merge_workspace_commit":"f".repeat(40),"workspace_revision":{"repository":"test/merge-workspace","commit":"f".repeat(40)},"evidence":evidence(),"conflict_paths":["src/change.rs"]})).unwrap();
    let result = resolve(&db, &json!({"op":"resolve_conflict","conflict_id":"conflict:unresolved","request_id":"resolve-1","expected_version":1,"owner_brief":"Preserve both API behaviors"}), 3).unwrap();
    assert_eq!(result["status"], "resolving");
    let job = get(&db, "jobs", "job:conflict-resolver:resolve-1").unwrap();
    assert_eq!(job["kind"], "agent");
    assert_eq!(job["payload"]["team_owned_paths"], json!(["src/change.rs"]));
    assert_eq!(
        job["payload"]["conflict_resolver"]["candidate"]["revision"]["commit"],
        "c".repeat(40)
    );
    assert_eq!(job["payload"]["execution"]["budget"], execution["budget"]);
    assert!(
        job["payload"]["execution"]["task"]
            .as_str()
            .unwrap()
            .contains("conflict markers contain both sides")
    );
}

#[test]
fn clean_refresh_terminates_capture_and_freezes_fresh_evaluation_with_two_parents() {
    let db = setup();
    let receipt = refresh(&db, &request(), 2).unwrap();
    let job_id = receipt["job_id"].as_str().unwrap();
    let leased = execute(&db, json!({"op":"claim","job_id":job_id,"now":3})).unwrap();
    assert_eq!(leased["payload"]["workspace_transport"], "git-native-v1");
    let cid = format!("candidate:refresh:{}", "e".repeat(40));
    let result = json!({"status":"clean","evidence":evidence(),"candidate_id":cid,
        "revision":{"repository":"test/refresh-fork","commit":"e".repeat(40)},"tree":"f".repeat(40),
        "merge_commit":"e".repeat(40),"paths":["src/change.rs"],"diff_digest":"d".repeat(64),"file_provenance":[],
        "readback":{"observed_head":"b".repeat(40),"version":1,"parents":["b".repeat(40),"c".repeat(40)],
        "candidate_paths":["src/change.rs"],"intervening_paths":["README.md"],"merge_commit":"e".repeat(40),"merged_paths":["src/change.rs"]}});
    complete(
        &db,
        &json!({"job_id":job_id,"epoch":leased["epoch"],"result":result}),
        4,
    )
    .unwrap();
    assert_eq!(get(&db, "jobs", job_id).unwrap()["status"], "done");
    let candidate = get(&db, "candidates", &cid).unwrap();
    assert_eq!(candidate["status"], "evaluating");
    assert_eq!(candidate["base"]["repository"], "test/conflict");
    assert_eq!(
        candidate["approved_parents"],
        json!(["b".repeat(40), "c".repeat(40)])
    );
    assert_eq!(candidate["refresh_expected_version"], 1);
    let evaluator = get(&db, "jobs", &format!("evaluate:{cid}")).unwrap();
    assert_eq!(evaluator["payload"]["workspace_transport"], "git-native-v1");
    assert_eq!(
        evaluator["payload"]["candidate"]["diff_digest"],
        "d".repeat(64)
    );
    assert!(candidate["evaluation"].is_null());
    let inventory = status(&db, &json!({"op":"conflict_status"})).unwrap();
    assert_eq!(inventory["conflicts"][0]["status"], "evaluating");
    assert_eq!(inventory["conflicts"][0]["merge_status"], "clean");
    let mut repository = repo(&db).unwrap();
    repository["head_commit"] = json!("1".repeat(40));
    repository["version"] = json!(2);
    save(&db, "repository", "repo", &repository).unwrap();
    assert_eq!(refresh(&db, &request(), 5).unwrap(), receipt);
}

#[test]
fn refresh_rejects_forged_tree_readback_atomically() {
    let db = setup();
    let receipt = refresh(&db, &request(), 2).unwrap();
    let jid = receipt["job_id"].as_str().unwrap();
    let leased = execute(&db, json!({"op":"claim","job_id":jid,"now":3})).unwrap();
    let before = get(&db, "jobs", jid).unwrap();
    assert!(complete(&db,&json!({"job_id":jid,"epoch":leased["epoch"],"result":{"status":"clean","evidence":evidence(),"readback":{"observed_head":"forged","version":1}}}),4).is_err());
    assert_eq!(get(&db, "jobs", jid).unwrap(), before);
}

#[test]
fn resolver_without_a_frozen_hosted_model_cannot_queue_a_paid_job() {
    let db = setup();
    let candidate = get(&db, "candidates", "candidate").unwrap();
    create(&db,"conflicts","external-conflict",&json!({"id":"external-conflict","candidate":candidate,"candidate_revision":"c".repeat(40),"expected_version":1,"head_commit":"b".repeat(40),"status":"unresolved","merge_workspace_commit":"f".repeat(40),"workspace_revision":{"repository":"test/merge","commit":"f".repeat(40)},"conflict_paths":["src/change.rs"]})).unwrap();
    let error = execute(&db,json!({"op":"resolve_conflict","conflict_id":"external-conflict","request_id":"external-resolve","expected_version":1,"owner_brief":"Retain both changes","now":3})).unwrap_err();
    assert_eq!(error.code, "MISSING_MODEL_APPROVAL");
    assert!(get(&db, "jobs", "job:conflict-resolver:external-resolve").is_err());
    assert_eq!(
        get(&db, "conflicts", "external-conflict").unwrap()["status"],
        "unresolved"
    );
}

#[test]
fn publication_pending_prevents_refresh_and_exhausted_capture_is_terminal() {
    let db = setup();
    let mut repository = repo(&db).unwrap();
    repository["pending"] = json!("decision:pending");
    save(&db, "repository", "repo", &repository).unwrap();
    assert_eq!(execute(&db,json!({"op":"refresh_candidate","request_id":"refresh-1","candidate_id":"candidate","expected_version":1,"expected_commit":"b".repeat(40),"now":2})).unwrap_err().code,"PUBLICATION_PENDING");
    repository["pending"] = Value::Null;
    save(&db, "repository", "repo", &repository).unwrap();
    let receipt = refresh(&db, &request(), 3).unwrap();
    let leased = execute(
        &db,
        json!({"op":"claim","job_id":receipt["job_id"],"now":4}),
    )
    .unwrap();
    execute(&db,json!({"op":"fail","job_id":receipt["job_id"],"epoch":leased["epoch"],"retryable":false,"error":"Controlled capture failure","now":5})).unwrap();
    assert_eq!(
        get(&db, "conflicts", receipt["conflict_id"].as_str().unwrap()).unwrap()["status"],
        "failed"
    );
    assert_eq!(
        get(&db, "jobs", receipt["job_id"].as_str().unwrap()).unwrap()["status"],
        "failed"
    );
}
