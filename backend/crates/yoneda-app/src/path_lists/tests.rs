use super::*;
use crate::native::NativeStore;
#[test]
fn large_path_manifest_persists_per_row_and_pages_without_2000_truncation() {
    let db = NativeStore::memory().unwrap();
    crate::migrate(&db).unwrap();
    let paths = json!(
        (0..10000)
            .map(|i| format!("{i:04}/{}/{}", "x".repeat(240), "y".repeat(240)))
            .collect::<Vec<_>>()
    );
    assert!(paths.to_string().len() > 2 * 1024 * 1024);
    let reference = persist(&db, &paths).unwrap();
    assert_eq!(reference["count"], 10000);
    assert_eq!(persist(&db, &paths).unwrap(), reference);
    let record = json!({"id":"candidate","paths_ref":reference});
    crate::storage::save(&db, "candidates", "candidate", &record).unwrap();
    assert_eq!(load(&db, &record, "paths").unwrap().len(), 10000);
    let mut after = Value::Null;
    let mut count = 0;
    loop {
        let p=page(&db,&json!({"candidate_id":"candidate","after":after,"limit":200,"expected_digest":reference["digest"]})).unwrap();
        assert!(p["items"].as_array().unwrap().len() <= 200);
        count += p["items"].as_array().unwrap().len();
        after = p["next_cursor"].clone();
        if after.is_null() {
            break;
        }
    }
    assert_eq!(count, 10000);
    assert_eq!(
        page(
            &db,
            &json!({"candidate_id":"candidate","expected_digest":"0".repeat(64)})
        )
        .unwrap_err()
        .code,
        "VERSION_CONFLICT"
    );
    let max = db
        .query(
            "SELECT MAX(length(CAST(payload AS BLOB))) AS size FROM source_path_lists",
            &[],
        )
        .unwrap();
    assert!(max[0]["size"].as_i64().unwrap() < 2048);
}
#[test]
fn corrupt_path_rows_are_fenced_and_legacy_cursor_remains_stable() {
    let db = NativeStore::memory().unwrap();
    crate::migrate(&db).unwrap();
    let reference = persist(&db, &json!(["a.rs", "z.rs"])).unwrap();
    let record = json!({"id":"candidate","paths_ref":reference});
    db.query(
        "DELETE FROM source_path_entries WHERE list_id=? AND path=?",
        &[reference["id"].clone(), json!("z.rs")],
    )
    .unwrap();
    assert_eq!(load(&db, &record, "paths").unwrap_err().code, "DATABASE");
    let legacy = json!({"id":"legacy","paths":["z.rs","a.rs"]});
    crate::storage::save(&db, "candidates", "legacy", &legacy).unwrap();
    let first = page(&db, &json!({"candidate_id":"legacy","limit":1})).unwrap();
    assert_eq!(first["items"], json!(["a.rs"]));
    let second=page(&db,&json!({"candidate_id":"legacy","limit":1,"after":first["next_cursor"],"expected_digest":first["digest"]})).unwrap();
    assert_eq!(second["items"], json!(["z.rs"]));
    assert_eq!(second["has_more"], false);
    assert_eq!(
        crate::storage::get(&db, "candidates", "legacy").unwrap(),
        legacy
    );
}
#[test]
fn frozen_team_scope_prefix_is_not_rejected_as_a_file_path() {
    let db = NativeStore::memory().unwrap();
    crate::migrate(&db).unwrap();
    let record = json!({"team_write_paths":["src/","**"]});
    assert_eq!(
        load(&db, &record, "team_write_paths").unwrap(),
        vec!["src/".to_owned(), "**".to_owned()]
    );
    let mut compacted = record;
    compact(&db, &mut compacted, "team_write_paths").unwrap();
    assert_eq!(
        load(&db, &compacted, "team_write_paths").unwrap(),
        vec!["**".to_owned(), "src/".to_owned()]
    );
}
