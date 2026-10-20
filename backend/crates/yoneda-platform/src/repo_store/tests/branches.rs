//! Working branches move by compare-and-swap with the write scope; main never does. A
//! fast-forward-only landing lands exactly the reviewed commit or reports STALE_HEAD.
use super::*;

fn branch(
    h: &Harness,
    who: &str,
    name: &str,
    commit: &str,
    expected: Value,
) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({"op":"repo_branch_set","ref":name,"commit":commit,"expected":expected}),
    )
}

#[test]
fn branches_move_by_compare_and_swap_and_main_is_protected() {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn a() { 2 }\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(
        code(branch(&h, CI, "candidates/one", &child, Value::Null)),
        "FORBIDDEN"
    );
    for name in ["main", "refs/heads/main"] {
        assert_eq!(
            code(branch(&h, AGENT, name, &child, json!(root))),
            "FORBIDDEN"
        );
    }
    let created = branch(&h, AGENT, "candidates/one", &root, Value::Null).unwrap();
    assert_eq!(created["ref"], "refs/heads/candidates/one");
    // Creating again (expected: nothing) or moving from a wrong head is stale.
    assert_eq!(
        code(branch(&h, AGENT, "candidates/one", &child, Value::Null)),
        "STALE_HEAD"
    );
    assert_eq!(
        code(branch(&h, AGENT, "candidates/one", &child, json!(child))),
        "STALE_HEAD"
    );
    let moved = branch(&h, AGENT, "candidates/one", &child, json!(root)).unwrap();
    assert_eq!(moved["commit"], child);
    // A retried move that already happened is a no-op, not a second log entry.
    assert_eq!(
        branch(&h, AGENT, "candidates/one", &child, json!(root)).unwrap()["already"],
        true
    );
    let refs = h.ok(OWNER, json!({"op":"repo_refs"}));
    assert_eq!(refs["refs"]["refs/heads/candidates/one"], child);
    assert_eq!(refs["refs"]["refs/heads/main"], root);
    let log = h.ok(OWNER, json!({"op":"repo_txlog","after":0,"limit":10}));
    let kinds: Vec<_> = log["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].clone())
        .collect();
    assert_eq!(kinds.iter().filter(|k| *k == "ref_move").count(), 2);
    // Unrecorded commits cannot be named.
    assert_eq!(
        code(branch(
            &h,
            AGENT,
            "candidates/two",
            &"f".repeat(40),
            Value::Null
        )),
        "NOT_FOUND"
    );
}

#[test]
fn fast_forward_only_landing_is_stale_when_main_moved_and_never_merges() {
    let (h, root) = seeded();
    let first = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/a.md", "a\n")]),
            json!([]),
        )
        .unwrap();
    let second = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/b.md", "b\n")]),
            json!([]),
        )
        .unwrap();
    for id in [&first, &second] {
        h.approve_and_check(id);
    }
    let landed = h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":first,"fast_forward_only":true}),
    );
    assert_eq!(landed["commit"], first);
    // main moved: a disjoint change would merge cleanly, but fast-forward-only refuses.
    let error = h
        .run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":second,"fast_forward_only":true}),
        )
        .unwrap_err();
    assert_eq!(error.code, "STALE_HEAD");
    assert!(error.message.contains(&first));
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"],
        first
    );
}

#[test]
fn a_merge_commit_without_clean_changes_keeps_the_first_parent_tree() {
    let (h, root) = seeded();
    let side = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn side() {}\n")]),
            json!([]),
        )
        .unwrap();
    // The conflict-workspace merge: both parents, none of the conflicting paths resolved yet.
    let merge = h
        .commit_with(
            AGENT,
            Some(&root),
            1,
            json!([]),
            json!([]),
            json!({"merge_parent": side}),
        )
        .unwrap();
    let commit = Commit::decode(&h.objects.borrow()[&merge].1).unwrap();
    let parent = Commit::decode(&h.objects.borrow()[&root].1).unwrap();
    assert_eq!(commit.tree().unwrap(), parent.tree().unwrap());
    assert_eq!(commit.parents().unwrap().len(), 2);
}
