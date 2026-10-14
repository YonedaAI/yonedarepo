use crate::{execute_workspace, native::NativeStore};
use serde_json::{Value, json};

fn call(db: &NativeStore, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(1000);
    execute_workspace(db, command)
}

fn fixture() -> (NativeStore, Value) {
    let db = NativeStore::memory().unwrap();
    call(&db, json!({"op":"signup","username":"guide_owner","password":"offline guide fixture password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    let policy = json!({"version":"task-board-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["guided-task-board"],"build":{"setup":[],"checks":[{"name":"guided-task-board","argv":["node","/opt/yoneda/test-bundle/fixtures/guided-task-board/oracle/run.mjs"],"timeout_seconds":30}],"static_dir":"public","test_bundle":{"digest":"d".repeat(64),"protected_paths":["README.md",".yoneda-guided","fixtures/guided-task-board/oracle"]}}});
    let marker = json!({"profile_id":"task-board-v1","version":1,"starter":{"repository":"local/starter","branch":"main","commit":"a".repeat(40),"tree":"b".repeat(40)},"policy_digest":yoneda_core::fingerprint(&policy).unwrap(),"test_bundle_digest":"d".repeat(64)});
    (
        db,
        json!({"op":"project_reserve","id":"fresh-guide","name":"Fresh guide","source":null,"policy":policy,"_guided_project":marker}),
    )
}

#[test]
fn guided_project_metadata_is_retained_and_replay_cannot_rebind_it() {
    let (db, request) = fixture();
    let first = call(&db, request.clone()).unwrap();
    assert_eq!(first["guided_project"], request["_guided_project"]);
    assert_eq!(call(&db, request.clone()).unwrap(), first);
    let mut changed = request;
    changed["_guided_project"]["starter"]["commit"] = json!("c".repeat(40));
    assert_eq!(call(&db, changed).unwrap_err().code, "INVALID_INPUT");
    assert_eq!(
        call(&db, json!({"op":"project_get","id":"fresh-guide"})).unwrap(),
        first
    );
}

#[test]
fn guided_project_public_marker_cannot_adopt_an_ordinary_project() {
    let (db, request) = fixture();
    let mut ordinary = request.clone();
    ordinary["guided_project"] = ordinary["_guided_project"].clone();
    ordinary.as_object_mut().unwrap().remove("_guided_project");
    let saved = call(&db, ordinary).unwrap();
    assert!(saved.get("guided_project").is_none());
    assert_eq!(call(&db, request).unwrap_err().code, "INVALID_INPUT");
}

#[test]
fn guided_project_invalid_starter_identity_is_rejected_before_reservation() {
    let (db, request) = fixture();
    for (field, value) in [
        ("repository", "/starter"),
        ("repository", "local/.."),
        ("branch", "../main"),
        ("branch", "refs/heads/a.lock"),
    ] {
        let mut invalid = request.clone();
        invalid["_guided_project"]["starter"][field] = json!(value);
        assert!(call(&db, invalid).is_err(), "accepted {field}: {value}");
        assert_eq!(
            call(&db, json!({"op":"project_get","id":"fresh-guide"}))
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );
    }
}
