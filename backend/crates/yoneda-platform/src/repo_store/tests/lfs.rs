//! Git LFS: downloads need `read`, uploads `write`, the quota the owner; a path-restricted
//! token is refused. A batch reserves its uploads against the quota as a whole (a batch
//! that does not fit reserves nothing), reservations lapse after a day, only stored objects
//! download, and a verified store fits the quota too. Its tables arrive additively.
use super::*;
use crate::repo_store::lfs::{DEFAULT_QUOTA_BYTES, MAX_OBJECT_BYTES, PENDING_MS};
use crate::storage::SqlStore;

fn oid(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

fn batch(h: &Harness, who: &str, operation: &str, objects: Value) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({"op":"repo_lfs_batch","operation":operation,"objects":objects}),
    )
}

fn usage(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_lfs_usage"}))
}

#[test]
fn downloads_need_read_uploads_write_and_the_whole_repository() {
    let h = Harness::new();
    let one = json!([{"oid": oid(1), "size": 10}]);
    // ci holds read and check: it may ask to download, never to upload or store.
    assert_eq!(code(batch(&h, CI, "download", one.clone())), "OK");
    assert_eq!(code(batch(&h, CI, "upload", one.clone())), "FORBIDDEN");
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_lfs_store","oid":oid(1),"size":10}))),
        "FORBIDDEN"
    );
    assert_eq!(code(batch(&h, AGENT, "upload", one.clone())), "OK");
    h.ok(OWNER, json!({"op":"repo_token_create","name":"dir","scopes":["read","write"],"paths":["src/"],"_secret":"dir-secret-0123456789abcdef0123456789"}));
    assert_eq!(code(batch(&h, "token:dir", "download", one)), "FORBIDDEN");
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_lfs_batch","operation":"delete","objects":[]})
        )),
        "INVALID_INPUT"
    );
    // Only the owner (or an admin) sets the quota.
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_lfs_set_quota","quota_bytes":1}))),
        "FORBIDDEN"
    );
}

#[test]
fn uploads_are_reserved_stored_and_then_download() {
    let h = Harness::new();
    let answer = batch(
        &h,
        AGENT,
        "upload",
        json!([
            {"oid": oid(1), "size": 100},
            {"oid": "ABC", "size": 1},
            {"oid": oid(2), "size": MAX_OBJECT_BYTES + 1}
        ]),
    )
    .unwrap();
    let objects = answer["objects"].as_array().unwrap();
    assert_eq!(
        objects[0],
        json!({"oid": oid(1), "size": 100, "upload": true})
    );
    assert_eq!(objects[1]["error"]["code"], 422);
    assert_eq!(objects[2]["error"]["code"], 422);
    assert_eq!(usage(&h)["pending_bytes"], 100);

    // Reserved but not verified: nothing to download yet.
    let pending = batch(&h, CI, "download", json!([{"oid": oid(1), "size": 100}])).unwrap();
    assert_eq!(pending["objects"][0]["error"]["code"], 404);

    let stored = h.ok(
        AGENT,
        json!({"op":"repo_lfs_store","oid":oid(1),"size":100}),
    );
    assert_eq!(stored["already"], false);
    let again = h.ok(
        AGENT,
        json!({"op":"repo_lfs_store","oid":oid(1),"size":100}),
    );
    assert_eq!(again["already"], true);
    let u = usage(&h);
    assert_eq!(
        (
            u["stored_bytes"].clone(),
            u["pending_bytes"].clone(),
            u["objects"].clone()
        ),
        (json!(100), json!(0), json!(1))
    );

    let down = batch(
        &h,
        CI,
        "download",
        json!([{"oid": oid(1), "size": 100}, {"oid": oid(1), "size": 7}]),
    )
    .unwrap();
    assert_eq!(
        down["objects"][0],
        json!({"oid": oid(1), "size": 100, "present": true})
    );
    assert_eq!(down["objects"][1]["error"]["code"], 422);
    // A stored object needs no upload.
    let up = batch(&h, AGENT, "upload", json!([{"oid": oid(1), "size": 100}])).unwrap();
    assert_eq!(up["objects"][0]["present"], true);
    // A stored object is never discarded; a pending one is.
    assert_eq!(
        h.ok(AGENT, json!({"op":"repo_lfs_discard","oid":oid(1)}))["stored"],
        true
    );
    batch(&h, AGENT, "upload", json!([{"oid": oid(3), "size": 5}])).unwrap();
    assert_eq!(
        h.ok(AGENT, json!({"op":"repo_lfs_discard","oid":oid(3)}))["stored"],
        false
    );
    assert_eq!(usage(&h)["used_bytes"], 100);
}

#[test]
fn the_quota_refuses_whole_batches_and_counts_reservations() {
    let h = Harness::new();
    assert_eq!(usage(&h)["quota_bytes"], DEFAULT_QUOTA_BYTES);
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_lfs_set_quota","quota_bytes":-1}))),
        "INVALID_INPUT"
    );
    h.ok(OWNER, json!({"op":"repo_lfs_set_quota","quota_bytes":1000}));

    batch(&h, AGENT, "upload", json!([{"oid": oid(1), "size": 600}])).unwrap();
    // 600 reserved: 300 + 200 more do not fit, and neither is reserved.
    let refused = batch(
        &h,
        AGENT,
        "upload",
        json!([{"oid": oid(2), "size": 300}, {"oid": oid(3), "size": 200}]),
    )
    .unwrap_err();
    assert_eq!(refused.code, "QUOTA_EXCEEDED");
    assert!(
        refused.message.contains("600 of 1000"),
        "{}",
        refused.message
    );
    assert_eq!(usage(&h)["used_bytes"], 600);
    // Asking for the same pending object again re-reserves it, not twice.
    batch(
        &h,
        AGENT,
        "upload",
        json!([{"oid": oid(1), "size": 600}, {"oid": oid(2), "size": 400}]),
    )
    .unwrap();
    assert_eq!(usage(&h)["used_bytes"], 1000);

    // An unreserved store must fit too.
    let over = h
        .run(AGENT, json!({"op":"repo_lfs_store","oid":oid(4),"size":1}))
        .unwrap_err();
    assert_eq!(over.code, "QUOTA_EXCEEDED");
    h.ok(
        AGENT,
        json!({"op":"repo_lfs_store","oid":oid(1),"size":600}),
    );

    // A day later the unverified reservation lapses and its bytes are the adapter's to delete.
    *h.now.borrow_mut() += PENDING_MS;
    let later = batch(&h, AGENT, "upload", json!([{"oid": oid(5), "size": 100}])).unwrap();
    assert_eq!(later["lapsed"], json!([oid(2)]));
    assert_eq!(usage(&h)["used_bytes"], 700);

    // Lowering the quota keeps what is stored and refuses more.
    h.ok(OWNER, json!({"op":"repo_lfs_set_quota","quota_bytes":0}));
    assert_eq!(
        code(batch(
            &h,
            AGENT,
            "upload",
            json!([{"oid": oid(6), "size": 1}])
        )),
        "QUOTA_EXCEEDED"
    );
    let kept = batch(&h, CI, "download", json!([{"oid": oid(1), "size": 600}])).unwrap();
    assert_eq!(kept["objects"][0]["present"], true);
}

#[test]
fn upgrades_from_the_releases_schema_with_empty_lfs_tables() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations
        .iter()
        .position(|(version, _)| *version == 33)
        .unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    for table in ["lfs_objects", "lfs_quota"] {
        assert!(
            db.query(&format!("SELECT * FROM {table}"), &[])
                .unwrap()
                .is_empty()
        );
    }
}
