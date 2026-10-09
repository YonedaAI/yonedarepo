use super::*;

fn execution_node(db: &NativeStore, id: &str) -> Value {
    crate::storage::get(db, "nodes", id).unwrap()
}

#[test]
fn capture_and_evaluation_keep_execution_graph_in_sync() {
    let db = repo();
    captured(&db);
    let id = "run-one:codex-minimal";
    assert_eq!(execution_node(&db, id)["data"]["status"], "evaluating");
    let job = "evaluate:candidate-a";
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    let policy = crate::storage::repo(&db).unwrap()["policy"].clone();
    call(
        &db,
        json!({"op":"finish","job_id":job,"epoch":1,"result":{
            "id":"evaluation-a","candidate":"candidate-a",
            "revision":{"repository":"yoneda-dev/fork-a","commit":"c".repeat(40)},
            "policy":policy["version"],"suite":policy["suite"],"environment":policy["environment"],
            "evidence":"e".repeat(64),"checks":[
                {"name":"build","status":"pass","detail":"compiled"},
                {"name":"behavior","status":"pass","detail":"verified"}
            ]
        }}),
    )
    .unwrap();
    let execution = crate::storage::get(&db, "executions", id).unwrap();
    assert_eq!(execution["status"], "completed");
    assert_eq!(execution_node(&db, id)["data"], execution);
    // Duplicate delivery cannot regress the completed projection.
    call(&db, json!({"op":"claim","job_id":job})).unwrap();
    assert_eq!(execution_node(&db, id)["data"], execution);
}

#[test]
fn cancellation_updates_the_execution_graph() {
    let db = repo();
    start(&db);
    call(&db, json!({"op":"claim","job_id":"job:run-one:research"})).unwrap();
    call(&db, json!({"op":"cancel_run","run_id":"run-one"})).unwrap();
    assert_eq!(
        execution_node(&db, "run-one:research")["data"]["status"],
        "cancelled"
    );
}

#[test]
fn cancellation_during_evaluation_updates_execution_and_graph() {
    let db = repo();
    captured(&db);
    call(&db, json!({"op":"cancel_run","run_id":"run-one"})).unwrap();
    let execution = crate::storage::get(&db, "executions", "run-one:codex-minimal").unwrap();
    assert_eq!(execution["status"], "cancelled");
    assert_eq!(
        execution_node(&db, "run-one:codex-minimal")["data"],
        execution
    );
}

#[test]
fn migration_repairs_old_execution_nodes_without_changing_evidence() {
    let db = repo();
    ready(&db);
    let id = "run-one:codex-minimal";
    let before = call(&db, json!({"op":"snapshot"})).unwrap();
    let mut stale = execution_node(&db, id);
    stale["data"]["status"] = json!("capturing");
    crate::storage::save(&db, "nodes", id, &stale).unwrap();
    db.query("DELETE FROM schema_migrations WHERE version=3", &[])
        .unwrap();
    migrate(&db).unwrap();
    let repaired = execution_node(&db, id);
    assert_eq!(
        repaired["data"],
        crate::storage::get(&db, "executions", id).unwrap()
    );
    assert_eq!(repaired["recorded_at"], stale["recorded_at"]);
    let after = call(&db, json!({"op":"snapshot"})).unwrap();
    for key in [
        "repository",
        "executions",
        "candidates",
        "evaluations",
        "artifacts",
        "edges",
        "seq",
    ] {
        assert_eq!(after[key], before[key], "Migration changed {key}");
    }
    migrate(&db).unwrap();
    assert_eq!(execution_node(&db, id), repaired);
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM schema_migrations", &[])
            .unwrap()[0]["count"],
        8
    );
}

#[test]
fn run_and_candidate_nodes_follow_authoritative_transitions() {
    let db = repo();
    ready(&db);
    assert_eq!(execution_node(&db, "run-one")["data"]["status"], "ready");
    assert_eq!(
        execution_node(&db, "candidate-a")["data"]["status"],
        "eligible"
    );
    call(&db, json!({"op":"cancel_run","run_id":"run-one"})).unwrap();
    assert_eq!(
        execution_node(&db, "run-one")["data"]["status"],
        "cancelled"
    );
}

#[test]
fn cancellation_during_evaluation_fences_the_candidate() {
    let db = repo();
    captured(&db);
    call(&db, json!({"op":"cancel_run","run_id":"run-one"})).unwrap();
    assert_eq!(
        execution_node(&db, "candidate-a")["data"]["status"],
        "cancelled"
    );
}
