use crate::source_capture_manifest::{assemble_manifest, page_items};
use serde_json::json;
#[test]
fn exact_sealed_paged_metadata_assembles_and_tampered_digest_fails() {
    let (binding, _, overrides, changeset) = crate::source_capture_tests::fixture();
    let mut header = serde_json::to_value(&changeset).unwrap();
    header.as_object_mut().unwrap().remove("changes");
    header.as_object_mut().unwrap().remove("baseline_overrides");
    let changes = changeset
        .changes
        .iter()
        .map(|c| serde_json::to_value(c).unwrap())
        .collect::<Vec<_>>();
    let overrides = overrides
        .iter()
        .map(|o| serde_json::to_value(o).unwrap())
        .collect::<Vec<_>>();
    let digest = changeset.digest().unwrap();
    assert_eq!(
        assemble_manifest(
            &binding,
            &header,
            changes.clone(),
            overrides.clone(),
            &digest
        )
        .unwrap(),
        changeset
    );
    assert!(assemble_manifest(&binding, &header, changes, overrides, &"f".repeat(64)).is_err());
}
#[test]
fn bounded_pages_reject_repeated_paths_wrong_digest_and_more_than_two_hundred_rows() {
    let digest = "a".repeat(64);
    let page = json!({"items":[{"path":"next","before":null,"after":null}],"next_cursor":null,"changeset_digest":digest});
    assert_eq!(page_items(&page, &digest, None).unwrap().len(), 1);
    assert!(page_items(&page, &"b".repeat(64), None).is_err());
    assert!(page_items(&page, &digest, Some("next")).is_err());
    let page = json!({"items":(0..201).map(|n|json!({"path":format!("{n:04}")})).collect::<Vec<_>>(),"next_cursor":null,"changeset_digest":digest});
    assert!(page_items(&page, &digest, None).is_err());
}
