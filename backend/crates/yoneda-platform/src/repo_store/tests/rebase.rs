//! Server-side rebase: the authority plans which commits of a working branch to replay onto
//! another branch's head; the adapter (played here) three-way merges each one in stateless
//! compute, commits it, and moves the branch with one compare-and-swap on the planned head.
use super::*;
use crate::platform_compute::compute;

fn plan(h: &Harness, who: &str, branch: &str) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({"op":"repo_rebase_plan","ref":branch,"onto":"main"}),
    )
}

/// Merges `theirs` into `ours` from `base` in compute, supplying trees and blobs on request.
fn merge(h: &Harness, base: &Value, ours: &Value, theirs: &Value) -> Value {
    let (mut trees, mut blobs) = (serde_json::Map::new(), serde_json::Map::new());
    loop {
        let merged = compute(
            json!({"op":"merge_trees","base":base,"ours":ours,"theirs":theirs,
            "trees":trees,"blobs":blobs}),
        )
        .unwrap();
        if let Some(need) = merged["need_trees"].as_array() {
            for id in need.iter().filter_map(Value::as_str) {
                trees.insert(id.into(), h.tree_json(id));
            }
        } else if let Some(need) = merged["need_blobs"].as_array() {
            for id in need.iter().filter_map(Value::as_str) {
                blobs.insert(id.into(), json!(STANDARD.encode(&h.objects.borrow()[id].1)));
            }
        } else {
            return merged;
        }
    }
}

/// The planned commits replayed onto the planned base; the new head, or the conflicts.
fn replay(h: &Harness, who: &str, plan: &Value) -> std::result::Result<String, Value> {
    let mut head = plan["onto_head"].as_str().unwrap().to_owned();
    let mut tree = plan["onto_tree"].clone();
    for item in plan["commits"].as_array().unwrap() {
        let merged = merge(h, &item["parent_tree"], &tree, &item["tree"]);
        if !merged["conflicts"].as_array().unwrap().is_empty() {
            return Err(merged["conflicts"].clone());
        }
        let extra = json!({"message": item["message"]});
        head = h
            .commit_with(
                who,
                Some(&head),
                plan["version"].as_u64().unwrap(),
                merged["changes"].clone(),
                json!([]),
                extra,
            )
            .unwrap();
        tree = h.ok(
            OWNER,
            json!({"op":"repo_commit","commit":head,"brief":true}),
        )["tree"]
            .clone();
    }
    Ok(head)
}

fn finish(h: &Harness, branch: &str, head: &str, expected: &Value) -> yoneda_core::Result<Value> {
    h.run(
        AGENT,
        json!({"op":"repo_branch_set","ref":branch,"commit":head,"expected":expected}),
    )
}

fn branch_head(h: &Harness, branch: &str) -> Value {
    h.ok(OWNER, json!({"op":"repo_refs"}))["refs"][format!("refs/heads/{branch}")].clone()
}

fn land_on_main(h: &Harness, parent: &str, changes: Value) -> String {
    let version = h.ok(OWNER, json!({"op":"repo_status"}))["version"]
        .as_u64()
        .unwrap();
    let id = h
        .commit(AGENT, Some(parent), version, changes, json!([]))
        .unwrap();
    h.approve_and_check(&id);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    id
}

fn touches(h: &Harness, commit: &str) -> Value {
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":commit}));
    let mut paths = detail["paths"].clone();
    for path in paths.as_array_mut().unwrap() {
        path.as_object_mut().unwrap().remove("old_blob");
    }
    paths
}

/// main: root -> notes; feature: notes -> edit lib, edit notes line 1; then main edits
/// README and notes line 5.
fn diverged() -> (Harness, String, Vec<String>) {
    let (h, root) = seeded();
    let notes = land_on_main(&h, &root, json!([file("notes.txt", "a\nb\nc\nd\ne\n")]));
    let one = h
        .commit(
            AGENT,
            Some(&notes),
            2,
            json!([file("src/lib.rs", "pub fn a() { 1 }\n")]),
            json!([]),
        )
        .unwrap();
    let two = h
        .commit_with(
            AGENT,
            Some(&one),
            2,
            json!([file("notes.txt", "A\nb\nc\nd\ne\n")]),
            json!([]),
            json!({"message": "Capitalize a\n"}),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"feature","commit":two,"expected":null}),
    );
    let main = land_on_main(
        &h,
        &notes,
        json!([
            file("README.md", "# moved\n"),
            file("notes.txt", "a\nb\nc\nd\nE\n")
        ]),
    );
    (h, main, vec![one, two])
}

#[test]
fn clean_rebase_replays_each_commit_onto_main_in_order() {
    let (h, main, old) = diverged();
    let planned = plan(&h, AGENT, "feature").unwrap();
    assert_eq!(planned["ref"], "refs/heads/feature");
    assert_eq!(planned["head"], json!(old[1]));
    assert_eq!(planned["onto_head"], json!(main));
    let ids: Vec<&Value> = planned["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| &c["commit"])
        .collect();
    assert_eq!(ids, vec![&json!(old[0]), &json!(old[1])]);
    let head = replay(&h, AGENT, &planned).unwrap();
    let moved = finish(&h, "feature", &head, &planned["head"]).unwrap();
    assert_eq!(moved["commit"], json!(head));
    assert_eq!(branch_head(&h, "feature"), json!(head));
    // Linear: the new second commit sits on the new first, which sits on main.
    let second = h.ok(OWNER, json!({"op":"repo_commit","commit":head}));
    let first_id = second["parents"][0].as_str().unwrap().to_owned();
    let first = h.ok(OWNER, json!({"op":"repo_commit","commit":first_id}));
    assert_eq!(second["parents"].as_array().unwrap().len(), 1);
    assert_eq!(first["parents"], json!([main]));
    assert_eq!(second["message"], "Capitalize a\n");
    // Each replayed commit writes what the original wrote, except where main's edit to the
    // same file merged in cleanly (line 5 stays main's).
    assert_eq!(touches(&h, &first_id), touches(&h, &old[0]));
    let merged = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"A\nb\nc\nd\nE\n");
    assert_eq!(second["paths"][0]["path"], "notes.txt");
    assert_eq!(second["paths"][0]["new_blob"], json!(merged));
    // Planning again: nothing left to replay.
    assert_eq!(plan(&h, AGENT, "feature").unwrap()["up_to_date"], true);
}

#[test]
fn conflicting_rebase_reports_paths_and_leaves_the_branch() {
    let (h, root) = seeded();
    let mine = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn a() { 1 }\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"feature","commit":mine,"expected":null}),
    );
    land_on_main(&h, &root, json!([file("src/lib.rs", "pub fn a() { 2 }\n")]));
    let planned = plan(&h, AGENT, "feature").unwrap();
    let conflicts = replay(&h, AGENT, &planned).unwrap_err();
    assert_eq!(conflicts[0]["path"], "src/lib.rs");
    assert_eq!(conflicts[0]["kind"], "content");
    for side in ["base", "ours", "theirs"] {
        assert!(conflicts[0][side].is_string(), "{side}");
    }
    assert_eq!(branch_head(&h, "feature"), json!(mine));
}

#[test]
fn a_branch_moved_since_the_plan_is_not_overwritten() {
    let (h, _main, old) = diverged();
    let planned = plan(&h, AGENT, "feature").unwrap();
    let head = replay(&h, AGENT, &planned).unwrap();
    // Someone pushes to the branch meanwhile: the planned head is stale.
    let pushed = h
        .commit(
            AGENT,
            Some(&old[1]),
            2,
            json!([file("docs/late.md", "late\n")]),
            json!([]),
        )
        .unwrap();
    finish(&h, "feature", &pushed, &json!(old[1])).unwrap();
    assert_eq!(
        code(finish(&h, "feature", &head, &planned["head"])),
        "STALE_HEAD"
    );
    assert_eq!(branch_head(&h, "feature"), json!(pushed));
}

#[test]
fn up_to_date_branches_are_a_no_op() {
    let (h, root) = seeded();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"same","commit":root,"expected":null}),
    );
    let at_main = plan(&h, AGENT, "same").unwrap();
    assert_eq!(at_main["up_to_date"], true);
    assert_eq!(at_main["head"], json!(root));
    let ahead = h
        .commit(AGENT, Some(&root), 1, json!([file("x", "x\n")]), json!([]))
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"ahead","commit":ahead,"expected":null}),
    );
    let planned = plan(&h, AGENT, "ahead").unwrap();
    assert_eq!(planned["up_to_date"], true);
    assert_eq!(planned["commits"], Value::Null);
}

#[test]
fn main_merges_unknown_branches_and_readers_are_refused() {
    let (h, root) = seeded();
    for name in ["main", "refs/heads/main", "release/1"] {
        assert_eq!(code(plan(&h, AGENT, name)), "FORBIDDEN", "{name}");
    }
    assert_eq!(code(plan(&h, AGENT, "missing")), "NOT_FOUND");
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"feature","commit":root,"expected":null}),
    );
    // Rebasing is a write: a read/check token cannot plan one.
    assert_eq!(code(plan(&h, CI, "feature")), "FORBIDDEN");
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op":"repo_rebase_plan","ref":"feature","onto":"feature"})
        )),
        "INVALID_INPUT"
    );
    // A merge commit on the branch is refused rather than flattened.
    let side = h
        .commit(AGENT, Some(&root), 1, json!([file("s", "s\n")]), json!([]))
        .unwrap();
    let joined = h
        .commit_with(
            AGENT,
            Some(&root),
            1,
            json!([file("t", "t\n")]),
            json!([]),
            json!({"merge_parent": side}),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"feature","commit":joined,"expected":root}),
    );
    land_on_main(&h, &root, json!([file("m", "m\n")]));
    assert_eq!(code(plan(&h, AGENT, "feature")), "NOT_SUPPORTED");
}
