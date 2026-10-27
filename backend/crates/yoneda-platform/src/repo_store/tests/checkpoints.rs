//! Checkpoints carry a digest of their full ref map, repeated in the next log entry, so a
//! ref altered inside a stored checkpoint is refused even when no later entry touches it.
use super::*;
use crate::storage::SqlStore;

/// Main at `root`, `side` at `root`, and `work` moved until the log passes version 64.
fn past_a_checkpoint() -> (Harness, String, String) {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("n.txt", "1\n")]),
            json!([]),
        )
        .unwrap();
    let set = |name: &str, commit: &str, expected: Value| {
        h.ok(
            AGENT,
            json!({"op":"repo_branch_set","ref":name,"commit":commit,"expected":expected}),
        )["version"]
            .as_u64()
            .unwrap()
    };
    set("side", &root, Value::Null);
    let mut at = (root.clone(), set("work", &root, Value::Null));
    while at.1 < 66 {
        let next = if at.0 == root { &child } else { &root };
        at = (next.clone(), set("work", next, json!(at.0)));
    }
    (h, root, child)
}

fn side_at(h: &Harness, version: u64) -> yoneda_core::Result<Value> {
    h.run(
        OWNER,
        json!({"op":"repo_snapshot","ref":"side","at":version}),
    )
}

#[test]
fn a_ref_altered_inside_a_checkpoint_is_refused_on_restore() {
    let (h, root, child) = past_a_checkpoint();
    let stored =
        h.db.query("SELECT checkpoint,refs_digest FROM txlog_checkpoints", &[])
            .unwrap();
    assert_eq!(stored.len(), 1);
    let digest = stored[0]["refs_digest"].as_str().unwrap().to_owned();
    let next = &h
        .db
        .query("SELECT entry FROM txlog WHERE version=65", &[])
        .unwrap()[0]["entry"];
    assert!(
        next.as_str().unwrap().contains(&digest),
        "entry 65 records it"
    );
    assert_eq!(side_at(&h, 66).unwrap()["commit"], json!(root));

    // `side` is not touched after version 64, so replay alone would trust the altered value.
    h.db.query(
        "UPDATE txlog_checkpoints SET checkpoint=replace(checkpoint,?,?)",
        &[
            json!(format!("\"refs/heads/side\":\"{root}\"")),
            json!(format!("\"refs/heads/side\":\"{child}\"")),
        ],
    )
    .unwrap();
    let error = side_at(&h, 66).unwrap_err();
    assert_eq!(error.code, "TXLOG_INVALID");
    assert!(
        error.message.contains("disagrees with its digest"),
        "{error}"
    );

    // Recomputing the stored digest too is caught by the digest the next entry carries.
    let altered =
        h.db.query("SELECT checkpoint FROM txlog_checkpoints", &[])
            .unwrap();
    let altered: yoneda_core::txlog::Checkpoint =
        serde_json::from_str(altered[0]["checkpoint"].as_str().unwrap()).unwrap();
    h.db.query(
        "UPDATE txlog_checkpoints SET refs_digest=?",
        &[json!(altered.refs_digest().unwrap())],
    )
    .unwrap();
    let error = side_at(&h, 66).unwrap_err();
    assert_eq!(error.code, "TXLOG_INVALID");
    assert!(error.message.contains("next log entry"), "{error}");
    assert_eq!(
        side_at(&h, 63).unwrap()["commit"],
        json!(root),
        "versions before the checkpoint replay from the start"
    );
}

#[test]
fn checkpoints_without_a_digest_are_not_trusted() {
    let (h, root, child) = past_a_checkpoint();
    // A checkpoint written before digests existed, altered: replay starts before it.
    h.db.query(
        "UPDATE txlog_checkpoints SET refs_digest=NULL,checkpoint=replace(checkpoint,?,?)",
        &[json!(root), json!(child)],
    )
    .unwrap();
    assert_eq!(side_at(&h, 66).unwrap()["commit"], json!(root));
}
