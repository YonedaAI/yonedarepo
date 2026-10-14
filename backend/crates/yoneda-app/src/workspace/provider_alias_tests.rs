use crate::{SqlStore, execute_workspace, native::NativeStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut c: Value) -> yoneda_core::Result<Value> {
    c["now"] = json!(1000);
    execute_workspace(db, c)
}
fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"signup","username":"alice","password":"private test password","salt":"01".repeat(16),"session_hash":"a".repeat(64),"recovery_hash":"b".repeat(64)})).unwrap();
    call(&db, json!({"op":"provider_put","provider":"claude","connection":"source-claude","model":"claude-sonnet-5-5","sealed":{"v":2,"iv":"original-iv","ciphertext":"original-encrypted"}})).unwrap();
    db
}
fn alias() -> Value {
    json!({"op":"provider_model_alias","provider":"claude","source_connection":"source-claude","expected_version":1,"connection":"alias-opus","model":"claude-opus-5-5","label":"Opus model alias","sealed":{"v":2,"iv":"new-iv","ciphertext":"new-encrypted"}})
}

#[test]
fn model_alias_is_create_only_replay_safe_and_leaves_original_credentials_unchanged() {
    let db = fixture();
    let original = call(
        &db,
        json!({"op":"provider_secret","connection":"source-claude"}),
    )
    .unwrap();
    let created = call(&db, alias()).unwrap();
    assert_eq!(created["model"], "claude-opus-5-5");
    assert_eq!(created["version"], 1);
    assert!(created.get("sealed").is_none());
    let mut retry = alias();
    retry["sealed"]["ciphertext"] = json!("different-retry-encrypted");
    assert_eq!(call(&db, retry).unwrap(), created);
    let saved = call(
        &db,
        json!({"op":"provider_secret","connection":"alias-opus"}),
    )
    .unwrap();
    assert_eq!(saved["sealed"]["ciphertext"], "new-encrypted");
    assert_eq!(
        saved["alias_source"],
        json!({"connection":"source-claude","version":1})
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"provider_secret","connection":"source-claude"})
        )
        .unwrap(),
        original
    );
    assert_eq!(call(&db, json!({"op":"provider_update","connection":"alias-opus","expected_version":1,"model":"claude-sonnet-5-5"})).unwrap_err().code, "ALIAS_IMMUTABLE");
    let mut overwrite = alias();
    overwrite["op"] = json!("provider_put");
    assert_eq!(call(&db, overwrite).unwrap_err().code, "ALIAS_IMMUTABLE");
}

#[test]
fn settings_exposes_safe_alias_provenance() {
    let db = fixture();
    let created = call(&db, alias()).unwrap();
    let settings = call(&db, json!({"op":"settings"})).unwrap();
    let listed = settings["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "alias-opus")
        .unwrap();
    assert_eq!(listed["alias_source"], created["alias_source"]);
    assert!(listed.get("sealed").is_none());
    let original = settings["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "source-claude")
        .unwrap();
    assert_eq!(original.get("alias_source"), Some(&Value::Null));
}

#[test]
fn delete_permanently_retires_alias_identity_without_reenabling_old_approvals() {
    let db = fixture();
    call(&db, alias()).unwrap();
    call(
        &db,
        json!({"op":"provider_delete","connection":"alias-opus"}),
    )
    .unwrap();
    assert!(
        call(
            &db,
            json!({"op":"provider_secret","connection":"alias-opus"})
        )
        .is_err()
    );
    assert_eq!(call(&db, alias()).unwrap_err().code, "ALIAS_RETIRED");
    let mut overwrite = alias();
    overwrite["op"] = json!("provider_put");
    assert_eq!(call(&db, overwrite).unwrap_err().code, "ALIAS_RETIRED");
    let retired = db
        .query(
            "SELECT payload FROM workspace_records WHERE id='provider-retired:alias-opus'",
            &[],
        )
        .unwrap();
    let marker: Value = serde_json::from_str(retired[0]["payload"].as_str().unwrap()).unwrap();
    assert_eq!(marker, json!({"id":"alias-opus","retired_at":1000}));
    call(
        &db,
        json!({"op":"provider_delete","connection":"alias-opus"}),
    )
    .unwrap();
    assert_eq!(call(&db, alias()).unwrap_err().code, "ALIAS_RETIRED");
    call(&db, json!({"op":"provider_update","connection":"source-claude","expected_version":1,"sealed":{"v":2,"iv":"rotated","ciphertext":"rotated"}})).unwrap();
    let mut next = alias();
    next["connection"] = json!("alias-opus-new-source-version");
    next["expected_version"] = json!(2);
    assert_eq!(call(&db, next).unwrap()["version"], 1);
    assert_eq!(
        call(&db, json!({"op":"settings"})).unwrap()["providers"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn aliases_reject_stale_source_models_unpriced_targets_and_existing_connection_reuse() {
    let db = fixture();
    let mut stale = alias();
    stale["expected_version"] = json!(0);
    assert_eq!(call(&db, stale).unwrap_err().code, "STALE_CONNECTION");
    let mut unknown = alias();
    unknown["model"] = json!("unverified-model");
    assert_eq!(call(&db, unknown).unwrap_err().code, "INVALID_INPUT");
    let mut wrong = alias();
    wrong["provider"] = json!("codex");
    assert_eq!(call(&db, wrong).unwrap_err().code, "INVALID_INPUT");
    let mut reused = alias();
    reused["connection"] = json!("source-claude");
    assert_eq!(call(&db, reused).unwrap_err().code, "IDEMPOTENCY_CONFLICT");
    let mut unpriced = alias();
    // This supported historical model has no current conservative catalog price.
    // MiMo 2.6 is now priced and is no longer a valid denial fixture.
    unpriced["model"] = json!("claude-sonnet-4-6");
    yoneda_core::providers::validate_model("claude", "claude-sonnet-4-6").unwrap();
    assert_eq!(call(&db, unpriced).unwrap_err().code, "INVALID_INPUT");
}

#[test]
fn atomic_alias_create_fences_a_source_key_changed_after_server_read() {
    let db = fixture();
    call(&db, json!({"op":"provider_update","connection":"source-claude","expected_version":1,"sealed":{"v":2,"iv":"rotated","ciphertext":"rotated-encrypted"}})).unwrap();
    assert_eq!(call(&db, alias()).unwrap_err().code, "STALE_CONNECTION");
    assert!(
        call(
            &db,
            json!({"op":"provider_secret","connection":"alias-opus"})
        )
        .is_err()
    );
}

#[test]
fn malformed_source_versions_fail_closed_but_absent_legacy_version_remains_compatible() {
    let db = fixture();
    for version in [
        json!(-1),
        json!(1.5),
        json!("1"),
        Value::Null,
        json!(9_007_199_254_740_992_i64),
    ] {
        db.query("UPDATE workspace_records SET payload=json_set(payload,'$.version',json(?)) WHERE id='provider:source-claude'", &[json!(version.to_string())]).unwrap();
        let mut request = alias();
        request["expected_version"] = json!(0);
        assert_eq!(call(&db, request).unwrap_err().code, "INVALID_INPUT");
    }
    db.query("UPDATE workspace_records SET payload=json_remove(payload,'$.version') WHERE id='provider:source-claude'", &[]).unwrap();
    let mut request = alias();
    request["expected_version"] = json!(0);
    assert_eq!(call(&db, request).unwrap()["version"], 1);
}

#[derive(Clone)]
struct AliasReadFailure {
    db: NativeStore,
}
impl SqlStore for AliasReadFailure {
    fn query(&self, sql: &str, params: &[Value]) -> yoneda_core::Result<Vec<Value>> {
        if sql == "SELECT payload FROM workspace_records WHERE id=?"
            && params.first() == Some(&json!("provider:alias-opus"))
        {
            return Err(yoneda_core::Error::new(
                "DATABASE",
                "Injected target alias read failure",
            ));
        }
        self.db.query(sql, params)
    }
    fn transaction(
        &self,
        action: Box<dyn FnOnce() -> yoneda_core::Result<Value>>,
    ) -> yoneda_core::Result<Value> {
        self.db.transaction(action)
    }
}

#[test]
fn an_alias_read_failure_never_becomes_permission_to_create_or_overwrite() {
    let db = fixture();
    let store = AliasReadFailure { db: db.clone() };
    let mut request = alias();
    request["now"] = json!(1000);
    assert_eq!(
        execute_workspace(&store, request).unwrap_err().code,
        "DATABASE"
    );
    assert!(
        call(
            &db,
            json!({"op":"provider_secret","connection":"alias-opus"})
        )
        .is_err()
    );
    call(&db, alias()).unwrap();
    let before = call(
        &db,
        json!({"op":"provider_secret","connection":"alias-opus"}),
    )
    .unwrap();
    let mut overwrite = alias();
    overwrite["now"] = json!(1000);
    overwrite["op"] = json!("provider_put");
    assert_eq!(
        execute_workspace(&store, overwrite).unwrap_err().code,
        "DATABASE"
    );
    assert_eq!(
        call(
            &db,
            json!({"op":"provider_secret","connection":"alias-opus"})
        )
        .unwrap(),
        before
    );
}
