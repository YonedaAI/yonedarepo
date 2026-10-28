//! The bundle index: only the platform writes or reads it, rows are validated, the first
//! location of an object wins, and the table arrives by an additive migration.
use super::*;
use crate::storage::SqlStore;

const PROJECTOR: &str = "platform:projection";
const BUNDLE: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn id(n: u8) -> String {
    format!("{n:02x}").repeat(20)
}

fn index(h: &Harness, who: &str, bundle: &str, objects: Value) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({"op": "repo_bundle_index", "bundle": bundle, "objects": objects}),
    )
}

#[test]
fn indexes_and_locates_bundled_objects_for_the_platform_only() {
    let h = Harness::new();
    let objects = json!([
        {"id": id(1), "kind": "blob", "at": 25, "size": 7},
        {"id": id(2), "kind": "tree", "at": 57, "size": 30},
    ]);
    for who in [OWNER, AGENT, CI] {
        assert_eq!(code(index(&h, who, BUNDLE, objects.clone())), "FORBIDDEN");
        let read = h.run(who, json!({"op": "repo_bundle_locate", "ids": [id(1)]}));
        assert_eq!(code(read), "FORBIDDEN");
    }
    assert_eq!(index(&h, PROJECTOR, BUNDLE, objects).unwrap()["indexed"], 2);
    let located = h.ok(
        PROJECTOR,
        json!({"op": "repo_bundle_locate", "ids": [id(1), id(2), id(3)]}),
    )["located"]
        .clone();
    let mut rows = located.as_array().unwrap().clone();
    rows.sort_by_key(|r| r["id"].as_str().unwrap().to_owned());
    assert_eq!(
        json!(rows),
        json!([
            {"id": id(1), "bundle": BUNDLE, "at": 25, "size": 7, "kind": "blob"},
            {"id": id(2), "bundle": BUNDLE, "at": 57, "size": 30, "kind": "tree"},
        ])
    );
    // Another copy of the same object elsewhere keeps the first location.
    let other = "f".repeat(64);
    index(
        &h,
        PROJECTOR,
        &other,
        json!([{"id": id(1), "kind": "blob", "at": 0, "size": 7}]),
    )
    .unwrap();
    let again = h.ok(
        PROJECTOR,
        json!({"op": "repo_bundle_locate", "ids": [id(1)]}),
    );
    assert_eq!(again["located"][0]["bundle"], BUNDLE);
}

#[test]
fn answers_locations_with_a_staged_read_and_flags_bundled_repositories() {
    let h = Harness::new();
    let status = |h: &Harness| h.ok(OWNER, json!({"op": "repo_status"}))["bundled"].clone();
    let staged = |locate: bool| {
        h.ok(
            PROJECTOR,
            json!({"op": "repo_staged_objects", "ids": [id(1), id(3)], "locate": locate}),
        )
    };
    assert_eq!(status(&h), false);
    assert_eq!(staged(true)["located"], json!([]));
    let objects = json!([{"id": id(1), "kind": "blob", "at": 25, "size": 7}]);
    index(&h, PROJECTOR, BUNDLE, objects).unwrap();
    assert_eq!(status(&h), true);
    let read = staged(true);
    assert_eq!(read["objects"], json!([]));
    assert_eq!(
        read["located"],
        json!([{"id": id(1), "bundle": BUNDLE, "at": 25, "size": 7, "kind": "blob"}])
    );
    // Without `locate`, the staged read answers as before.
    assert!(staged(false).get("located").is_none());
}

#[test]
fn refuses_malformed_index_rows_and_oversized_calls() {
    let h = Harness::new();
    let one = |object: Value| json!([object]);
    let blob = json!({"id": id(1), "kind": "blob", "at": 0, "size": 1});
    for bundle in ["abc", &"A".repeat(64), &"g".repeat(64), "../x"] {
        assert_eq!(
            code(index(&h, PROJECTOR, bundle, one(blob.clone()))),
            "INVALID_INPUT"
        );
    }
    for bad in [
        json!({"id": "nope", "kind": "blob", "at": 0, "size": 1}),
        json!({"id": id(1), "kind": "tag", "at": 0, "size": 1}),
        json!({"id": id(1), "kind": "blob", "at": -1, "size": 1}),
        json!({"id": id(1), "kind": "blob", "at": 0, "size": 1u64 << 33}),
        json!({"id": id(1), "kind": "blob", "at": 0}),
    ] {
        assert_ne!(code(index(&h, PROJECTOR, BUNDLE, one(bad))), "OK");
    }
    assert_eq!(
        code(index(&h, PROJECTOR, BUNDLE, json!([]))),
        "INVALID_INPUT"
    );
    let many = vec![blob.clone(); super::super::pushed::bundles::INDEX_OBJECTS + 1];
    assert_eq!(
        code(index(&h, PROJECTOR, BUNDLE, json!(many))),
        "INVALID_INPUT"
    );
    let ids = vec![id(1); super::super::pushed::bundles::LOCATE_IDS + 1];
    let read = h.run(PROJECTOR, json!({"op": "repo_bundle_locate", "ids": ids}));
    assert_eq!(code(read), "INVALID_INPUT");
    // A refused call indexed nothing, not even its valid rows.
    let mixed = json!([blob, {"id": id(2), "kind": "tag", "at": 0, "size": 1}]);
    assert_ne!(code(index(&h, PROJECTOR, BUNDLE, mixed)), "OK");
    let read = h.ok(
        PROJECTOR,
        json!({"op": "repo_bundle_locate", "ids": [id(1), id(2)]}),
    );
    assert_eq!(read["located"], json!([]));
}

#[test]
fn upgrades_from_the_compaction_schema_with_an_empty_index() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..29])
        .unwrap();
    db.query(
        "INSERT INTO txlog_retention(id,keep_versions,keep_ms) VALUES(1,64,1000)",
        &[],
    )
    .unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(
        db.query("SELECT id FROM bundled_objects", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT keep_versions FROM txlog_retention", &[])
            .unwrap()[0]["keep_versions"],
        64
    );
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        30
    );
}
