//! Optional status selection is authoritative and never substitutes a projected ref.
use super::batches::open;
use super::*;

fn selected(h: &Harness, who: &str, min: u64) -> Value {
    h.ok(
        who,
        json!({"op":"repo_status","snapshot":{"ref":"main","min_version":min}}),
    )
}

#[test]
fn status_snapshot_pins_the_same_authority_version_and_recorded_tree() {
    let (h, root) = open();
    let snapshot = h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}));
    let status = selected(&h, OWNER, 0);
    assert_eq!(status["snapshot"], snapshot);
    assert_eq!(status["snapshot"]["version"], status["version"]);
    assert_eq!(status["snapshot"]["commit"], root);
    let next = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("next.txt", "next\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":next}));
    assert_eq!(status["snapshot"]["commit"], root);
    assert_eq!(selected(&h, OWNER, 0)["snapshot"]["commit"], next);
    assert!(
        h.ok(OWNER, json!({"op":"repo_status"}))
            .get("snapshot")
            .is_none()
    );
}

#[test]
fn status_snapshot_omits_pending_missing_fork_and_restricted_selections() {
    let empty = Harness::new();
    assert!(selected(&empty, OWNER, 0).get("snapshot").is_none());
    let (h, _) = open();
    assert!(selected(&h, OWNER, 10_000).get("snapshot").is_none());
    assert!(
        h.ok(
            OWNER,
            json!({"op":"repo_status","at":0,"snapshot":{"ref":"main"}})
        )
        .get("snapshot")
        .is_none()
    );
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"public","scopes":["read"],
        "paths":["docs/"],"_secret":"public-secret-0123456789abcdef0123456789"}),
    );
    assert!(selected(&h, "token:public", 0).get("snapshot").is_none());
    let fork = super::forks::fork(&h);
    assert!(selected(&fork, OWNER, 0).get("snapshot").is_none());
    let landed = h.shard_commit(AGENT, "pending.txt", "pending\n", json!([]));
    assert_eq!(
        h.submit(vec![(OWNER, &landed)])["items"][0]["status"],
        "landed"
    );
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_snapshot","ref":"main"}))),
        "PROJECTION_PENDING"
    );
    assert!(selected(&h, OWNER, 0).get("snapshot").is_none());
    h.project_all();
    assert!(selected(&h, OWNER, 0)["snapshot"]["commit"].is_string());
}

#[test]
fn status_snapshot_current_selection_does_not_replay_archived_history() {
    let (h, root) = open();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("next.txt", "next\n")]),
            json!([]),
        )
        .unwrap();
    super::compaction::grow(&h, &root, &child, 1_100);
    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":64,"keep_days":30}),
    );
    let archived = super::compaction::Store::default();
    assert_eq!(
        super::compaction::compact_once(&h, &archived, json!({}))["floor"],
        1_024
    );
    assert_eq!(selected(&h, OWNER, 0)["snapshot"]["commit"], root);
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_snapshot","ref":"main","at":1}))),
        "TXLOG_ARCHIVED"
    );
}
