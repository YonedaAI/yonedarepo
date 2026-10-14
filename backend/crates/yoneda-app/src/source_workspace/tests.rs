use super::*;
pub(super) mod fixtures;
use fixtures as f;
#[test]
fn source_init_isolated_schema_and_frozen_view_replay() {
    let db = f::db();
    let status = f::init(&db);
    assert_eq!(status["workspace_version"], 0);
    assert_eq!(status["authority"], "staged_source");
    let again = f::call(&db, f::init_input()).unwrap();
    assert_eq!(again, status);
    assert!(
        db.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='runs'",
            &[]
        )
        .unwrap()
        .is_empty()
    );
}
#[test]
fn metadata_reads_reuse_immutable_base_without_full_file_content() {
    let db = f::db();
    f::init(&db);
    let record=f::call(&db,json!({"op":"source_read","path":"src/main.rs","expected_file_version":0,"offset":1,"limit":2})).unwrap();
    assert_eq!(record["content"]["kind"], "git");
    assert_eq!(record["content"]["path"], "src/main.rs");
    assert_eq!(record["length"], 2);
    assert!(record.get("bytes").is_none());
    let listing = f::call(&db, json!({"op":"source_list","prefix":"src/","limit":1})).unwrap();
    assert_eq!(listing["items"][0]["path"], "src/main.rs");
}
mod storage_bounds;
#[test]
fn expired_ticket_maintenance_is_private_and_does_not_need_producer_actor() {
    let db = f::db();
    f::init(&db);
    let t = f::ticket(&db, "new.rs", b"orphan", 0, 0);
    let id = t["ticket"]["id"].clone();
    let due = f::call(
        &db,
        json!({"op":"source_gc_due","now":300000,"_actor":null}),
    )
    .unwrap();
    assert_eq!(due["tickets"][0]["id"], id);
    let claim = json!({"op":"source_gc_claim","request_id":format!("gc-claim:{}",id.as_str().unwrap()),"ticket_id":id,"now":300000,"_gc_grant":due["gc_grant"]});
    let result = f::call(&db, claim.clone()).unwrap();
    assert_eq!(f::call(&db, claim).unwrap(), result);
    assert_eq!(result["state"], "gc_pending");
    let write=f::call(&db,json!({"op":"source_create","request_id":"late-create","path":"new.rs","ticket_id":id,"expected_workspace_version":0,"expected_file_version":0,"now":300000})).unwrap_err();
    assert!(matches!(
        write.code.as_str(),
        "UPLOAD_EXPIRED" | "UPLOAD_UNAVAILABLE"
    ));
    let mut forged = due["gc_grant"].clone();
    forged["claims"]["purpose"] = json!("source");
    assert_eq!(f::call(&db,json!({"op":"source_gc_claim","request_id":"forged","ticket_id":id,"now":300000,"_gc_grant":forged})).unwrap_err().code,"FORBIDDEN");
}
#[test]
fn copy_rename_are_atomic_scoped_and_preserve_original_git_pointer() {
    let db = f::db();
    f::init(&db);
    let input = json!({"op":"source_copy","request_id":"copy","from":"src/main.rs","to":"src/copy.rs","overwrite":false,"expected_workspace_version":0,"expected_from_version":0,"expected_to_version":0});
    let copied = f::call(&db, input.clone()).unwrap();
    assert_eq!(copied["workspace_version"], 1);
    assert_eq!(f::call(&db, input).unwrap(), copied);
    let read = f::call(
        &db,
        json!({"op":"source_read","path":"src/copy.rs","expected_file_version":1}),
    )
    .unwrap();
    assert_eq!(read["content"]["path"], "src/main.rs");
    let collision = json!({"op":"source_rename","request_id":"collision","from":"src/copy.rs","to":"README.md/child","overwrite":false,"expected_workspace_version":1,"expected_from_version":1,"expected_to_version":0});
    assert!(f::call(&db, collision).is_err());
    assert_eq!(
        get(&db, "sw_state", "workspace").unwrap()["workspace_version"],
        1
    );
    assert!(!row(&db, "src/copy.rs").unwrap()["file"].is_null());
    let protected = json!({"op":"source_copy","request_id":"protected","from":"src/main.rs","to":"schema.json","overwrite":false,"expected_workspace_version":1,"expected_from_version":0,"expected_to_version":0});
    assert_eq!(f::call(&db, protected).unwrap_err().code, "FORBIDDEN");
}
#[test]
fn checkpoints_seal_bind_current_delta_and_readonly_capture_not_producer_lease() {
    let db = f::db();
    f::init(&db);
    let t = f::ticket(&db, "src/main.rs", b"changed", 0, 0);
    f::call(&db,json!({"op":"source_write","request_id":"write","path":"src/main.rs","ticket_id":t["ticket"]["id"],"expected_workspace_version":0,"expected_file_version":0})).unwrap();
    let checkpoint = f::call(
        &db,
        json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":1}),
    )
    .unwrap();
    assert_eq!(checkpoint["change_count"], 1);
    assert!(checkpoint.get("changeset").is_none());
    let seal_input = json!({"op":"source_seal","request_id":"seal","expected_workspace_version":1,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]});
    let sealed = f::call(&db, seal_input.clone()).unwrap();
    assert_eq!(f::call(&db, seal_input).unwrap(), sealed);
    let attestation: SealAttestation = decode(&sealed["attestation"]).unwrap();
    auth::verify_seal(&attestation, &f::binding(), f::KEY).unwrap();
    let page=f::call(&db,json!({"op":"source_manifest","checkpoint_id":checkpoint["checkpoint_id"],"section":"changes","limit":1})).unwrap();
    assert_eq!(page["items"][0]["path"], "src/main.rs");
    assert_eq!(page["items"][0]["after"]["content"]["kind"], "r2");
    assert_eq!(f::call(&db,json!({"op":"source_delete","request_id":"after-seal","path":"src/main.rs","expected_workspace_version":1,"expected_file_version":1})).unwrap_err().code,"SOURCE_SEALED");
}
#[test]
fn captured_manifest_grant_is_separate_readonly_authority_and_forgery_fenced() {
    let db = f::db();
    f::init(&db);
    let checkpoint = f::call(
        &db,
        json!({"op":"source_checkpoint","request_id":"checkpoint","expected_workspace_version":0}),
    )
    .unwrap();
    let seal=f::call(&db,json!({"op":"source_seal","request_id":"seal","expected_workspace_version":0,"checkpoint_id":checkpoint["checkpoint_id"],"expected_checkpoint_digest":checkpoint["changeset_digest"]})).unwrap();
    let b = f::binding();
    let claims = CaptureClaims {
        version: 1,
        workspace_id: b.workspace_id.clone(),
        binding_digest: b.digest().unwrap(),
        seal_id: seal["seal_id"].as_str().unwrap().into(),
        checkpoint_id: checkpoint["checkpoint_id"].as_str().unwrap().into(),
        changeset_digest: checkpoint["changeset_digest"].as_str().unwrap().into(),
        capture_job_id: "capture:job".into(),
        capture_epoch: 2,
        expires_at: 310000,
        purpose: "read_manifest".into(),
    };
    let grant = auth::sign_capture(claims, f::KEY).unwrap();
    let input = json!({"op":"source_manifest","checkpoint_id":checkpoint["checkpoint_id"],"section":"view_files","now":300000,"_actor":null,"_capture_grant":grant});
    assert_eq!(
        f::call(&db, input.clone()).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let mut mutation = input.clone();
    mutation["op"] = json!("source_checkpoint");
    assert_eq!(f::call(&db, mutation).unwrap_err().code, "FORBIDDEN");
    let mut forged = input;
    forged["_capture_grant"]["claims"]["checkpoint_id"] = json!("other");
    assert_eq!(f::call(&db, forged).unwrap_err().code, "FORBIDDEN");
}
#[test]
fn read_actor_cannot_widen_binding_or_consume_tickets_and_replays_do_not_change_input() {
    let db = f::db();
    f::init(&db);
    let readonly =
        auth::sign_read_actor(&f::binding(), 200000, ActorPurpose::Source, f::KEY).unwrap();
    assert_eq!(f::call(&db,json!({"op":"source_upload_ticket","request_id":"readonly","path":"new.rs","_actor":readonly,"sha256":"a".repeat(64),"size":1,"mode":"100644","expected_workspace_version":0,"expected_file_version":0})).unwrap_err().code,"FORBIDDEN");
    let mut input = json!({"op":"source_copy","request_id":"replay","from":"src/main.rs","to":"copied.rs","overwrite":false,"expected_workspace_version":0,"expected_from_version":0,"expected_to_version":0});
    f::call(&db, input.clone()).unwrap();
    input["to"] = json!("other.rs");
    assert_eq!(
        f::call(&db, input).unwrap_err().code,
        "IDEMPOTENCY_CONFLICT"
    );
}
#[test]
fn source_schema_upgrade_from_previous_version_preserves_rows_and_replays() {
    let db = f::db();
    let previous = include_str!("../migrations/source_workspace/0001_source_workspace.sql");
    db.query(
        "CREATE TABLE source_schema_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    for statement in previous.split(';').filter(|s| !s.trim().is_empty()) {
        db.query(statement, &[]).unwrap();
    }
    db.query(
        "INSERT INTO source_schema_migrations(version,digest) VALUES(1,?)",
        &[json!(yoneda_core::digest(previous.as_bytes()))],
    )
    .unwrap();
    let original = json!(f::file("kept.rs", b"unchanged"));
    create(&db, "sw_baseline", "kept.rs", &original).unwrap();
    migrate_source_workspace(&db).unwrap();
    migrate_source_workspace(&db).unwrap();
    assert_eq!(get(&db, "sw_baseline", "kept.rs").unwrap(), original);
    assert_eq!(
        db.query(
            "SELECT COUNT(*) AS count FROM source_schema_migrations",
            &[]
        )
        .unwrap()[0]["count"],
        2
    );
    assert!(
        db.query("SELECT checkpoint_id,path FROM sw_deltas", &[])
            .unwrap()
            .is_empty()
    );
}
