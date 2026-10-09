use super::*;
use serde_json::json;
use yoneda_core::FileEntry;
fn source(value: Value) -> Workspace {
    serde_json::from_value(value).unwrap()
}
fn input(id: &str, paths: &[&str]) -> Value {
    json!({"task_id":id,"revision":{"repository":format!("captures/{id}"),"commit":"a".repeat(40)},"tree":"b".repeat(40),"write_paths":paths})
}
#[test]
fn assembles_complementary_captures_without_losing_deletions_binary_or_executable_bits() {
    let base =
        source(json!({"public/index.html":{"content":"base"},"src/old.js":{"content":"old"}}));
    let mut search = base.clone();
    search.remove("src/old.js");
    search.insert(
        "src/search.js".into(),
        FileEntry::from_bytes(vec![0, 255, 128], true),
    );
    let mut rsvp = base.clone();
    rsvp.insert(
        "public/rsvp.mjs".into(),
        FileEntry::from_bytes(b"rsvp".to_vec(), false),
    );
    let expected = [
        input("search", &["src/"]),
        input("rsvp", &["public/rsvp.mjs"]),
    ];
    let mut assembly = Assembly::new(&base, &expected).unwrap();
    assembly.apply(&expected[0], &search).unwrap();
    assembly.apply(&expected[1], &rsvp).unwrap();
    let result = assembly.finish().unwrap();
    assert!(!result.contains_key("src/old.js"));
    assert_eq!(result["src/search.js"].bytes().unwrap(), [0, 255, 128]);
    assert!(result["src/search.js"].executable);
    assert_eq!(result["public/rsvp.mjs"].bytes().unwrap(), b"rsvp");
    assert_eq!(result["public/index.html"].content, "base");
}
#[test]
fn dependent_capture_ancestor_files_cannot_undo_an_earlier_task_output() {
    let base = source(json!({"a.js":{"content":"base"},"b.js":{"content":"base"}}));
    let first = source(json!({"a.js":{"content":"first"},"b.js":{"content":"base"}}));
    let dependent =
        source(json!({"a.js":{"content":"stale ancestor"},"b.js":{"content":"second"}}));
    let expected = [input("first", &["a.js"]), input("second", &["b.js"])];
    let mut assembly = Assembly::new(&base, &expected).unwrap();
    assembly.apply(&expected[0], &first).unwrap();
    assembly.apply(&expected[1], &dependent).unwrap();
    let result = assembly.finish().unwrap();
    assert_eq!(result["a.js"].content, "first");
    assert_eq!(result["b.js"].content, "second");
}
#[test]
fn rejects_forged_missing_duplicate_or_reordered_inputs() {
    let base = source(json!({"a.js":{"content":"base"}}));
    let expected = [input("first", &["a.js"]), input("second", &["b.js"])];
    let mut assembly = Assembly::new(&base, &expected).unwrap();
    assert!(assembly.apply(&expected[1], &base).is_err());
    let mut forged = expected[0].clone();
    forged["revision"]["commit"] = json!("c".repeat(40));
    assert!(assembly.apply(&forged, &base).is_err());
    assert!(assembly.finish().is_err());
    assert!(Assembly::new(&base, &[expected[0].clone(), expected[0].clone()]).is_err());
}
#[test]
fn scope_enforcement_covers_additions_deletions_and_mode_changes() {
    let base = source(json!({"public/a.js":{"content":"base"},"private.js":{"content":"fixed"}}));
    let mut changed = base.clone();
    changed.remove("private.js");
    assert_eq!(
        validate_changes(&base, &changed, &json!(["public/"]))
            .unwrap_err()
            .code,
        "TEAM_SCOPE"
    );
    changed = base.clone();
    changed.insert(
        "publicity.js".into(),
        FileEntry::from_bytes(b"escape".to_vec(), false),
    );
    assert!(validate_changes(&base, &changed, &json!(["public/"])).is_err());
    changed = base.clone();
    changed.get_mut("private.js").unwrap().executable = true;
    assert!(validate_changes(&base, &changed, &json!(["public/"])).is_err());
    changed = base.clone();
    changed.remove("public/a.js");
    assert!(validate_changes(&base, &changed, &json!(["public/"])).is_ok());
}
