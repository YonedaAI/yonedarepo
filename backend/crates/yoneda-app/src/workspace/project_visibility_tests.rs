use crate::{SqlStore, execute_workspace, native::NativeStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut c: Value) -> yoneda_agents_core::Result<Value> {
    c["now"] = json!(1000);
    execute_workspace(db, c)
}

fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"signup","username":"alice","password":"long private test key","salt":"01".repeat(16),"session_hash":"a".repeat(64),"recovery_hash":"b".repeat(64)})).unwrap();
    call(&db, json!({"op":"project_reserve","id":"legacy","name":"Old project","policy":yoneda_agents_core::Policy::default()})).unwrap();
    call(
        &db,
        json!({"op":"project_update","id":"legacy","status":"ready"}),
    )
    .unwrap();
    db
}

fn change(hidden: bool, expected: bool) -> Value {
    json!({"op":"project_set_visibility","id":"legacy","_workspace":"alice","hidden":hidden,"expected_hidden":expected,"reason":"Exclude old demo from normal list","_visibility":{"repo_id":"legacy","workspace":"alice","quiescent":true,"all_runs_hidden":true,"current_result":false}})
}

#[test]
fn hides_and_restores_projects_without_deletion_or_mutating_policy_credentials_and_usage() {
    let db = fixture();
    let project = call(&db, json!({"op":"project_get","id":"legacy"})).unwrap();
    let records = db
        .query(
            "SELECT id,payload FROM workspace_records WHERE id NOT LIKE 'project:%' ORDER BY id",
            &[],
        )
        .unwrap();
    assert_eq!(call(&db, change(true, false)).unwrap()["hidden"], true);
    assert_eq!(
        call(&db, json!({"op":"projects"})).unwrap()["projects"],
        json!([])
    );
    let inventory = call(&db, json!({"op":"projects","include_hidden":true})).unwrap();
    assert_eq!(inventory["include_hidden"], true);
    assert_eq!(inventory["projects"][0]["id"], "legacy");
    assert_eq!(inventory["projects"][0]["hidden"], true);
    let direct = call(&db, json!({"op":"project_get","id":"legacy"})).unwrap();
    for field in ["id", "status", "policy", "source", "created_at"] {
        assert_eq!(direct[field], project[field]);
    }
    assert_eq!(
        db.query(
            "SELECT id,payload FROM workspace_records WHERE id NOT LIKE 'project:%' ORDER BY id",
            &[]
        )
        .unwrap(),
        records
    );
    assert_eq!(call(&db, change(false, true)).unwrap()["hidden"], false);
    assert_eq!(
        call(&db, json!({"op":"projects"})).unwrap()["projects"][0]["id"],
        "legacy"
    );
}

#[test]
fn requires_owner_and_trusted_matching_repository_preflight() {
    let db = fixture();
    for (key, value) in [("_workspace", json!("bob")), ("_visibility", Value::Null)] {
        let mut c = change(true, false);
        c[key] = value;
        assert_eq!(call(&db, c).unwrap_err().code, "FORBIDDEN");
    }
    let mut c = change(true, false);
    c["_visibility"]["repo_id"] = json!("other");
    assert_eq!(call(&db, c).unwrap_err().code, "FORBIDDEN");
    let mut c = change(true, false);
    c["_grant"] = json!("agent");
    assert_eq!(call(&db, c).unwrap_err().code, "FORBIDDEN");
}

#[test]
fn rejects_active_work_and_stale_visibility() {
    let db = fixture();
    let mut active = change(true, false);
    active["_visibility"]["quiescent"] = json!(false);
    assert_eq!(call(&db, active).unwrap_err().code, "RUN_ACTIVE_WORK");
    assert_eq!(
        call(&db, change(true, true)).unwrap_err().code,
        "VISIBILITY_CHANGED"
    );
    assert_eq!(
        call(&db, json!({"op":"projects"})).unwrap()["projects"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn hides_a_quiescent_checked_project_without_changing_direct_audit_or_funding() {
    let db = fixture();
    let before = call(&db, json!({"op":"project_get","id":"legacy"})).unwrap();
    let records = db
        .query(
            "SELECT id,payload FROM workspace_records WHERE id NOT LIKE 'project:%' ORDER BY id",
            &[],
        )
        .unwrap();
    let mut command = change(true, false);
    command["_visibility"]["all_runs_hidden"] = json!(false);
    command["_visibility"]["current_result"] = json!(true);
    assert_eq!(call(&db, command).unwrap()["hidden"], true);
    let direct = call(&db, json!({"op":"project_get","id":"legacy"})).unwrap();
    for field in ["id", "policy", "source", "status", "created_at"] {
        assert_eq!(direct[field], before[field]);
    }
    assert_eq!(
        db.query(
            "SELECT id,payload FROM workspace_records WHERE id NOT LIKE 'project:%' ORDER BY id",
            &[]
        )
        .unwrap(),
        records
    );
    assert_eq!(
        call(&db, json!({"op":"projects"})).unwrap()["projects"],
        json!([])
    );
    assert_eq!(
        call(&db, json!({"op":"projects","include_hidden":true})).unwrap()["projects"][0]["id"],
        "legacy"
    );
}
