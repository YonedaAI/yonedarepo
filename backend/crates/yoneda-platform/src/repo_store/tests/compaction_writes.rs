//! Writes across the compaction floor: a landing whose concurrent window reaches archived
//! versions checks against the archived segments the adapter supplies, with the same
//! outcome as on an uncompacted log, and webhook fan-out holds compaction back.
use super::compaction::{Store, compact_once, grow, run_archived};
use super::*;
use crate::storage::SqlStore;

const MERGER: &str = "platform:merge";

/// `team` gets `root` (version 2) and then `a` writing a.txt (version 3); 100 other
/// branches then move until `head`, and with `compact` everything due moves to `r2`.
fn old_team_branch(head: u64, compact: bool) -> (Harness, Store, String, String) {
    let (h, root) = seeded();
    h.ok(AGENT, json!({"op":"repo_land","ref":"team","commit":root}));
    let a = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(
        h.ok(AGENT, json!({"op":"repo_land","ref":"team","commit":a}))["version"],
        3
    );
    let other = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("n.txt", "1\n")]),
            json!([]),
        )
        .unwrap();
    grow(&h, &root, &other, head);
    let r2 = Store::default();
    if compact {
        h.ok(
            OWNER,
            json!({"op":"repo_set_retention","keep_versions":100}),
        );
        while compact_once(&h, &r2, json!({}))["due"] != false {}
    }
    (h, r2, root, a)
}

/// What landing on the old branch does: the merge plan of disjoint work, its landing, its
/// landing through a platform merge, and a commit that read the file `a` changed.
fn team_outcomes(compact: bool) -> Vec<String> {
    let (h, r2, root, a) = old_team_branch(1_200, compact);
    let now = h.ok(OWNER, json!({"op":"repo_status"}))["version"]
        .as_u64()
        .unwrap();
    let on_root = |path: &str, reads: Value| {
        h.commit(AGENT, Some(&root), now, json!([file(path, "x\n")]), reads)
            .unwrap()
    };
    let b = on_root("b.txt", json!([]));
    let stale_read = on_root("c.txt", json!(["a.txt"]));
    let run = |command: Value| run_archived(&h, AGENT, &r2, command);
    let plan = run(json!({"op":"repo_merge_plan","ref":"team","commit":b})).unwrap();
    let direct = code(run(json!({"op":"repo_land","ref":"team","commit":b})));
    let blob = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"x\n");
    let merge = h
        .commit_with(
            MERGER,
            Some(&a),
            now,
            json!([{"path": "b.txt", "blob": blob, "type": "blob"}]),
            json!([]),
            json!({"merge_parent": b}),
        )
        .unwrap();
    let merged = run(json!({"op":"repo_land","ref":"team","commit":b,"merge":merge})).unwrap();
    let conflict = run(json!({"op":"repo_land","ref":"team","commit":stale_read})).unwrap_err();
    vec![
        plan["outcome"].as_str().unwrap().to_owned(),
        direct,
        (merged["merged"] == json!(b)).to_string(),
        conflict.code,
        conflict.message.contains("a.txt").to_string(),
    ]
}

#[test]
fn an_old_branch_lands_after_compaction_as_it_did_before() {
    let before = team_outcomes(false);
    assert_eq!(
        (
            before[0].as_str(),
            before[1].as_str(),
            before[3].as_str(),
            before[4].as_str()
        ),
        ("rebase", "MERGE_REQUIRED", "CONFLICT", "true")
    );
    assert_eq!(before[2], "true", "lands through the platform merge");
    // Versions 2 and 3 (the branch's own landings) are archived now, and still decide.
    assert_eq!(team_outcomes(true), before);
}

#[test]
fn a_landing_asks_for_the_segments_it_needs_and_refuses_a_forged_one() {
    let (h, r2, root, _) = old_team_branch(1_200, true);
    let now = h.ok(OWNER, json!({"op":"repo_status"}))["version"]
        .as_u64()
        .unwrap();
    let b = h
        .commit(
            AGENT,
            Some(&root),
            now,
            json!([file("b.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    let land = json!({"op":"repo_land","ref":"team","commit":b});
    let asked = h.run(AGENT, land.clone()).unwrap_err();
    assert_eq!(asked.code, "TXLOG_ARCHIVED");
    let key = "_log/segment-00000000000000000000-00000000000000001024.json";
    assert!(asked.message.contains(key), "{asked}");
    let mut forged = land;
    forged["_archive"] = json!({ key: r2.borrow()[key].replacen("a.txt", "z.txt", 1) });
    assert_eq!(code(h.run(AGENT, forged)), "ARCHIVE_CORRUPT");
}

#[test]
fn a_landing_reaching_more_than_16_segments_back_is_told_to_rebase() {
    let (h, r2, root, _) = old_team_branch(17 * 1_024 + 200, true);
    let floor = h.ok(OWNER, json!({"op":"repo_compact_plan"}))["floor"].clone();
    assert_eq!(floor, 17 * 1_024);
    let now = h.ok(OWNER, json!({"op":"repo_status"}))["version"]
        .as_u64()
        .unwrap();
    let b = h
        .commit(
            AGENT,
            Some(&root),
            now,
            json!([file("b.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    let refused = run_archived(
        &h,
        AGENT,
        &r2,
        json!({"op":"repo_land","ref":"team","commit":b}),
    )
    .unwrap_err();
    assert_eq!(refused.code, "TXLOG_COMPACTED");
    assert!(
        refused.message.contains("rebase onto a newer version"),
        "{refused}"
    );
}

#[test]
fn webhook_fan_out_holds_compaction_until_it_has_read_past_a_segment() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
        "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":"r0123456789abcdef0123",
        "_workers_subdomain":"mlong-f01"}),
    );
    let other = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("n.txt", "1\n")]),
            json!([]),
        )
        .unwrap();
    grow(&h, &root, &other, 1_200);
    h.ok(
        OWNER,
        json!({"op":"repo_set_retention","keep_versions":100}),
    );
    let r2 = Store::default();
    // The hook's cursor is still at version 1: nothing it has not fanned out may move.
    assert_eq!(compact_once(&h, &r2, json!({}))["due"], false);
    let fanned = |h: &Harness| {
        h.ok("platform:hooks", json!({"op":"repo_hooks_fanout"}));
        h.db.query("SELECT version FROM hook_cursor", &[]).unwrap()[0]["version"]
            .as_u64()
            .unwrap()
    };
    while fanned(&h) < 1_000 {}
    assert_eq!(
        compact_once(&h, &r2, json!({}))["due"],
        false,
        "cursor short of 1,024"
    );
    while fanned(&h) < 1_024 {}
    assert_eq!(compact_once(&h, &r2, json!({}))["floor"], 1_024);
}
