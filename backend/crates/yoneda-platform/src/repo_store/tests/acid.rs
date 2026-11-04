//! The transaction contract of a landing (`docs/acid-plan.md`, steps 1 and 2), one test per
//! anomaly (Adya's names), played as the adapter plays a landing: plain `repo_land`, and on
//! `MERGE_REQUIRED` the platform merge (`repo_merge_plan`, `merge_trees`, a merge commit as
//! the platform merger, `repo_land` with `merge`). Write skew between members of one batch
//! (G2-item) is pinned in `changesets.rs` (`a_changeset_batch_never_lands_write_skew`,
//! `a_batch_merge_never_lands_write_skew`).
use super::*;

const MERGER: &str = "platform:merge";

/// A commit on `parent` from log version `base`, approved and checked so it may land.
fn ready(h: &Harness, parent: &str, base: u64, changes: Value, reads: Value) -> String {
    let id = h.commit(AGENT, Some(parent), base, changes, reads).unwrap();
    h.approve_and_check(&id);
    id
}

fn main_head(h: &Harness) -> String {
    h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/heads/main"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn land(h: &Harness, commit: &str) -> String {
    code(h.run(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":commit}),
    ))
}

/// Runs compute `command` to its answer, supplying the trees and blobs it asks for.
fn compute(h: &Harness, command: Value) -> Value {
    let (mut trees, mut blobs) = (serde_json::Map::new(), serde_json::Map::new());
    loop {
        let mut asked = command.clone();
        asked["trees"] = json!(trees);
        asked["blobs"] = json!(blobs);
        let step = crate::platform_compute(asked).unwrap();
        if let Some(need) = step["need_trees"].as_array() {
            for id in need.iter().filter_map(Value::as_str) {
                trees.insert(id.into(), h.raw_tree_json(id));
            }
        } else if let Some(need) = step["need_blobs"].as_array() {
            for id in need.iter().filter_map(Value::as_str) {
                blobs.insert(id.into(), json!(STANDARD.encode(&h.objects.borrow()[id].1)));
            }
        } else {
            return step;
        }
    }
}

/// What the platform merge of `commit` onto main would do: its plan and computed merge.
fn platform_merge(h: &Harness, commit: &str) -> (Value, Value) {
    let plan = h.ok(
        OWNER,
        json!({"op":"repo_merge_plan","ref":"main","commit":commit}),
    );
    let merged = compute(
        h,
        json!({"op":"merge_trees","base":plan["base_tree"],"ours":plan["head_tree"],"theirs":plan["commit_tree"]}),
    );
    (plan, merged)
}

/// Lands `commit` on main through the platform merge, which must be clean.
fn merge_land(h: &Harness, commit: &str) -> Value {
    assert_eq!(land(h, commit), "MERGE_REQUIRED");
    let (plan, merged) = platform_merge(h, commit);
    assert_eq!(merged["conflicts"], json!([]), "{merged}");
    let merge = h
        .commit_with(
            MERGER,
            plan["head"].as_str(),
            plan["version"].as_u64().unwrap(),
            merged["changes"].clone(),
            json!([]),
            json!({"merge_parent": commit}),
        )
        .unwrap();
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":commit,"merge":merge}),
    )
}

/// Main after the seed plus one landing that adds `path` with `text`.
fn seeded_with(path: &str, text: &str) -> (Harness, String) {
    let (h, root) = seeded();
    let base = ready(&h, &root, 1, json!([file(path, text)]), json!([]));
    assert_eq!(land(&h, &base), "OK");
    (h, base)
}

#[test]
fn dirty_write_g0_a_second_landing_from_the_same_base_never_overwrites_the_first() {
    let (h, root) = seeded();
    let a = ready(&h, &root, 1, json!([file("README.md", "A\n")]), json!([]));
    let b = ready(&h, &root, 1, json!([file("README.md", "B\n")]), json!([]));
    assert_eq!(land(&h, &a), "OK");
    // B's base is behind main: no compare-and-swap succeeds, it must merge.
    assert_eq!(land(&h, &b), "MERGE_REQUIRED");
    assert_eq!(main_head(&h), a);
    let entries = h.ok(OWNER, json!({"op":"repo_txlog"}))["entries"].clone();
    assert_eq!(entries.as_array().unwrap().len(), 2, "{entries}");
    // A working branch moves by compare-and-swap on the value its writer saw.
    let set = |commit: &str| {
        code(h.run(
            OWNER,
            json!({"op":"repo_branch_set","ref":"work","commit":commit,"expected":null}),
        ))
    };
    assert_eq!(set(&a), "OK");
    assert_eq!(set(&b), "STALE_HEAD");
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/heads/work"],
        a
    );
}

#[test]
fn atomic_multi_ref_batch_moves_nothing_when_one_lease_is_stale() {
    let (h, root) = seeded();
    let a = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("a.txt", "a\n")]),
            json!([]),
        )
        .unwrap();
    for name in ["w1", "w2"] {
        h.ok(
            OWNER,
            json!({"op":"repo_branch_set","ref":name,"commit":root,"expected":null}),
        );
    }
    let before = h.ok(OWNER, json!({"op":"repo_refs"}));
    let batch = h.ok(
        OWNER,
        json!({"op":"repo_branch_batch","updates":[
            {"ref":"w1","commit":a,"expected":root},
            {"ref":"w2","commit":a,"expected":a},
        ]}),
    );
    assert_eq!(batch["stale"], json!(["refs/heads/w2"]), "{batch}");
    assert_eq!(h.ok(OWNER, json!({"op":"repo_refs"})), before);
}

#[test]
fn lost_update_a_three_way_merge_keeps_both_edits() {
    let (h, base) = seeded_with("list.txt", "one\ntwo\nthree\nfour\nfive\n");
    let a = ready(
        &h,
        &base,
        2,
        json!([file("list.txt", "ONE\ntwo\nthree\nfour\nfive\n")]),
        json!([]),
    );
    let b = ready(
        &h,
        &base,
        2,
        json!([file("list.txt", "one\ntwo\nthree\nfour\nFIVE\n")]),
        json!([]),
    );
    assert_eq!(land(&h, &a), "OK");
    merge_land(&h, &b);
    assert_eq!(
        h.file_at(&main_head(&h), "list.txt").as_deref(),
        Some("ONE\ntwo\nthree\nfour\nFIVE\n")
    );
}

#[test]
fn lost_update_overlapping_edits_conflict_instead_of_dropping_one() {
    let (h, base) = seeded_with("list.txt", "one\ntwo\nthree\n");
    let a = ready(
        &h,
        &base,
        2,
        json!([file("list.txt", "one\nA\nthree\n")]),
        json!([]),
    );
    let b = ready(
        &h,
        &base,
        2,
        json!([file("list.txt", "one\nB\nthree\n")]),
        json!([]),
    );
    assert_eq!(land(&h, &a), "OK");
    assert_eq!(land(&h, &b), "MERGE_REQUIRED");
    let (plan, merged) = platform_merge(&h, &b);
    assert_eq!(plan["outcome"], "merge", "{plan}");
    assert_eq!(merged["conflicts"][0]["path"], "list.txt", "{merged}");
    assert_eq!(merged["changes"], json!([]), "{merged}");
    assert_eq!(main_head(&h), a);
}

#[test]
fn stale_read_with_declared_reads_conflicts() {
    let (h, root) = seeded();
    let writer = ready(
        &h,
        &root,
        1,
        json!([file("src/lib.rs", "pub fn w() {}\n")]),
        json!([]),
    );
    let reader = ready(
        &h,
        &root,
        1,
        json!([file("docs/use.md", "calls a()\n")]),
        json!(["src/lib.rs"]),
    );
    assert_eq!(land(&h, &writer), "OK");
    assert_eq!(land(&h, &reader), "CONFLICT");
    assert_eq!(main_head(&h), writer);
}

/// A reads x and writes y; B reads y and writes x; both from the same base. No serial order
/// explains both landing. With declared reads the second is refused; without them each
/// counts only its writes, and both land today. `docs/acid-plan.md` step 4 (a serializable
/// setting that counts writes as reads) is meant to close this.
#[test]
fn write_skew_without_declared_reads_lands_today() {
    let skew = |declared: bool| {
        let (h, base) = seeded_with("x.txt", "x0\n");
        let reads = |path: &str| if declared { json!([path]) } else { json!([]) };
        let a = ready(
            &h,
            &base,
            2,
            json!([file("y.txt", "y from x0\n")]),
            reads("x.txt"),
        );
        let b = ready(
            &h,
            &base,
            2,
            json!([file("x.txt", "x from y\n")]),
            reads("y.txt"),
        );
        assert_eq!(land(&h, &a), "OK");
        (h, b)
    };
    let (h, b) = skew(false);
    assert_eq!(merge_land(&h, &b)["merged"], b);
    let head = main_head(&h);
    assert_eq!(h.file_at(&head, "y.txt").as_deref(), Some("y from x0\n"));
    assert_eq!(h.file_at(&head, "x.txt").as_deref(), Some("x from y\n"));
    let (h, b) = skew(true);
    // B read y, which A wrote since B's base. (A's read of x was valid when it landed.)
    assert_eq!(land(&h, &b), "CONFLICT");
}
