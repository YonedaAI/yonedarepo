use crate::{SqlStore, execute_workspace, native::NativeStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut c: Value) -> yoneda_agents_core::Result<Value> {
    c["now"] = json!(1000);
    execute_workspace(db, c)
}
fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db,json!({"op":"signup","username":"transition_owner","password":"synthetic local password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    call(
        &db,
        json!({"op":"reviewer_configure","repo_id":"legacy_repo","expires":50000}),
    )
    .unwrap();
    db
}
fn configure() -> Value {
    json!({"op":"workspace_spend_configure","expected_version":0,"limit_microusd":50000000})
}
fn snapshot(db: &NativeStore) -> Value {
    json!({"records":db.query("SELECT id,payload FROM workspace_records ORDER BY id", &[]).unwrap(),"events":db.query("SELECT kind,at,data FROM workspace_events ORDER BY rowid", &[]).unwrap()})
}
/// A legacy trial lock retained from before trials and campaigns were retired.
fn retain(db: &NativeStore, id: &str, record: Value) {
    db.query(
        "UPDATE workspace_records SET payload=? WHERE id=?",
        &[json!(record.to_string()), json!(id)],
    )
    .unwrap();
    if db
        .query("SELECT id FROM workspace_records WHERE id=?", &[json!(id)])
        .unwrap()
        .is_empty()
    {
        crate::storage::create(db, "workspace_records", id, &record).unwrap();
    }
}

#[test]
fn retained_reviewer_trial_fences_configuration_before_repository_start() {
    let db = fixture();
    let mut policy = call(&db, json!({"op":"reviewer_status"})).unwrap();
    policy["active_trial"] = json!("paused_reviewer");
    retain(&db, "reviewer_policy", policy);
    let before = snapshot(&db);
    assert_eq!(
        call(&db, configure()).unwrap_err().code,
        "WORKSPACE_TRANSITION_BUSY"
    );
    assert_eq!(snapshot(&db), before);
    assert_eq!(
        call(&db, json!({"op":"workspace_spend_status"})).unwrap()["version"],
        0
    );
}

#[test]
fn retained_campaign_trial_fences_configuration_before_repository_start() {
    let db = fixture();
    retain(
        &db,
        "campaign:legacy_campaign",
        json!({"id":"legacy_campaign","active_trial":"paused_campaign"}),
    );
    let before = snapshot(&db);
    assert_eq!(
        call(&db, configure()).unwrap_err().code,
        "WORKSPACE_TRANSITION_BUSY"
    );
    assert_eq!(snapshot(&db), before);
}

#[test]
fn an_idle_reviewer_workspace_configures_its_allowance() {
    let db = fixture();
    call(&db, configure()).unwrap();
    assert_eq!(
        call(&db, json!({"op":"workspace_spend_status"})).unwrap()["version"],
        1
    );
    assert_eq!(
        call(&db, json!({"op":"reviewer_status"})).unwrap()["active_trial"],
        Value::Null
    );
}
