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
    execution["harness"] = json!("codex");
    execution["provider"] = json!("mimo");
    execution["model"] = json!("mimo-v2.6-flash");
    execution["context"] = json!([]);
    execution["budget"] = json!({"provider":"mimo","model":"mimo-v2.6-flash"});
    execution["team_role"] = json!("worker");
    save_execution(&db, &execution, 2).unwrap();
    let candidate = get(&db, "candidates", "candidate").unwrap();
    create(&db,"conflicts","conflict:unresolved",&json!({"id":"conflict:unresolved","repository_id":"conflict-repo","request_id":"refresh-1","candidate_id":"candidate","candidate":candidate,"candidate_revision":"c".repeat(40),"candidate_base":"a".repeat(40),"expected_version":1,"head_commit":"b".repeat(40),"status":"unresolved","evidence":evidence(),"conflict_paths":["src/change.rs"]})).unwrap();
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
