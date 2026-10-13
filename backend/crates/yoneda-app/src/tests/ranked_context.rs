use super::*;
use crate::storage::node;

#[test]
fn ranked_pages_hold_a_watermark_as_new_context_arrives() {
    let db = repo();
    for (id, at) in [("one", 1), ("two", 2), ("three", 3)] {
        node(
            &db,
            id,
            "finding",
            "Registration behavior",
            "owner",
            at,
            json!({"statement":"Registration keeps safe retries","file_paths":["src/api.mjs"]}),
        )
        .unwrap();
    }
    let first = call(&db,json!({"op":"context_search","ranked":true,"query":"Registration","file_path":"src/api.mjs","limit":1})).unwrap();
    assert_eq!(first["items"][0]["id"], "three");
    node(
        &db,
        "new",
        "finding",
        "Registration behavior",
        "owner",
        4,
        json!({"statement":"Registration changed","file_paths":["src/api.mjs"]}),
    )
    .unwrap();
    let second = call(&db,json!({"op":"context_search","ranked":true,"query":"Registration","file_path":"src/api.mjs","limit":1,"cursor":first["next_cursor"]})).unwrap();
    assert_eq!(second["items"][0]["id"], "two");
    assert_eq!(second["watermark"], first["watermark"]);
    assert!(call(&db,json!({"op":"context_search","ranked":true,"query":"Different","file_path":"src/api.mjs","cursor":first["next_cursor"]})).is_err());
}

#[test]
fn previous_run_constraints_survive_large_unrelated_history() {
    let db = repo();
    node(
        &db,
        "constraint-old",
        "constraint",
        "Preserve USD cents",
        "owner",
        1,
        json!({"statement":"Money must remain integer cents","intent_id":"intent:previous"}),
    )
    .unwrap();
    for index in 0..1001 {
        node(
            &db,
            &format!("noise-{index}"),
            "finding",
            "Unrelated interface finding",
            "owner",
            100 + index,
            json!({"statement":"Unrelated interface finding"}),
        )
        .unwrap();
    }
    let found=call(&db,json!({"op":"context_search","ranked":true,"query":"Add waitlist","lineage":"previous","limit":10})).unwrap();
    assert_eq!(found["items"][0]["id"], "constraint-old");
    assert_eq!(found["items"][0]["retrieval"]["authority"], "assertion");
}
