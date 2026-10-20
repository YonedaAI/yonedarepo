//! Stateless commits recorded in a commit shard, then adopted by the authority when it
//! needs them: begin authorizes, the shard verifies and stages, adoption brings parents
//! first and keeps gates, landing and projection exactly as for prepared commits.
use super::*;
use crate::commit_store::{execute_commit_store, migrate_commit_store};
use crate::platform_compute;

fn shard() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    migrate_commit_store(&db).unwrap();
    migrate_commit_store(&db).unwrap(); // repeatable
    db
}

fn on(db: &NativeStore, mut c: Value) -> yoneda_core::Result<Value> {
    c["_system"] = json!("commits");
    c["now"] = json!(1_800_000_000_000_i64);
    execute_commit_store(db, c)
}

/// Plays the adapter: begin, build statelessly (trees from the harness store), record.
fn commit_in(h: &Harness, s: &NativeStore, principal: &str, parent: Value, path: &str) -> Value {
    let begun = h.ok(
        principal,
        json!({"op": "repo_begin_commit", "parent": parent, "base_version": 1, "paths": [path]}),
    );
    let parent = if begun["parent_elsewhere"] == true {
        let record = on(
            s,
            json!({"op": "store_commit", "commit": begun["parent_id"]}),
        )
        .unwrap();
        json!({"id": record["commit"]["id"], "tree": record["commit"]["tree"], "generation": record["commit"]["generation"]})
    } else {
        begun["parent"].clone()
    };
    let mut trees = serde_json::Map::new();
    let author = json!({"name": "Agent", "email": "agent@example.com"});
    loop {
        let built = platform_compute(
            json!({"op": "build_commit", "now": 1_800_000_000_000_i64, "parent": parent,
            "changes": [file(path, "x\n")], "trees": trees, "message": path, "author": author}),
        )
        .unwrap();
        if let Some(need) = built["need_trees"].as_array() {
            for id in need {
                let id = id.as_str().unwrap();
                let tree = h.cached.borrow().get(id).map(|t| t["entries"].clone());
                trees.insert(id.into(), tree.unwrap_or_else(|| h.tree_json(id)));
            }
            continue;
        }
        for object in built["objects"].as_array().unwrap() {
            h.cached
                .borrow_mut()
                .insert(object["id"].as_str().unwrap().into(), object.clone());
        }
        let recorded = on(s, json!({"op": "store_record", "commit": built["commit"], "tree": built["tree"],
            "parents": built["parents"], "generation": built["generation"], "base_version": begun["base_version"],
            "principal": begun["principal"], "message": path, "read_set": [], "touches": built["touches"],
            "objects": built["raw"], "classes": {"overall": "logic", "files": []}}))
        .unwrap();
        assert_eq!(recorded["recorded"], true);
        return built;
    }
}

fn adopt(h: &Harness, s: &NativeStore, commit: &Value) -> yoneda_core::Result<Value> {
    let record = on(s, json!({"op": "store_commit", "commit": commit})).unwrap();
    h.run(
        "platform:commits",
        json!({"op": "repo_adopt_commit", "record": record}),
    )
}

#[test]
fn shard_commits_are_adopted_parents_first_and_land_like_any_other() {
    let (h, root) = seeded();
    let s = shard();
    let first = commit_in(&h, &s, AGENT, json!(root), "a.txt");
    let second = commit_in(&h, &s, AGENT, first["commit"].clone(), "b.txt");
    // The authority never saw them: nothing was written there by commit creation.
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op": "repo_commit", "commit": second["commit"]})
        )),
        "NOT_FOUND"
    );
    // Adoption needs the parent first.
    let early = adopt(&h, &s, &second["commit"]).unwrap_err();
    assert!(
        early.message.contains(first["commit"].as_str().unwrap()),
        "{}",
        early.message
    );
    adopt(&h, &s, &first["commit"]).unwrap();
    assert_eq!(adopt(&h, &s, &second["commit"]).unwrap()["adopted"], true);
    assert_eq!(adopt(&h, &s, &second["commit"]).unwrap()["already"], true);
    let shown = h.ok(
        OWNER,
        json!({"op": "repo_commit", "commit": second["commit"]}),
    );
    assert_eq!(shown["parents"], json!([first["commit"]]));
    assert_eq!(shown["review_classes"]["overall"], "logic");
    // Gates, landing and projection treat it like a prepared commit.
    for c in [&first, &second] {
        h.approve_and_check(c["commit"].as_str().unwrap());
        h.ok(
            OWNER,
            json!({"op": "repo_land", "ref": "main", "commit": c["commit"]}),
        );
    }
    let plan = h.ok(
        "platform:projection",
        json!({"op": "repo_projection_objects", "refname": "refs/heads/main"}),
    );
    assert_eq!(plan["commits"].as_array().unwrap().len(), 2);
    assert!(!plan["commits"][0]["objects"].as_array().unwrap().is_empty());
}

#[test]
fn shards_verify_what_they_record_and_only_the_platform_reaches_them() {
    let (h, root) = seeded();
    let s = shard();
    let built = commit_in(&h, &s, AGENT, json!(root), "a.txt");
    // Recording again is a no-op.
    let again = on(&s, json!({"op": "store_record", "commit": built["commit"], "tree": built["tree"],
        "parents": built["parents"], "generation": 2, "base_version": 1, "principal": "x", "message": "m",
        "read_set": [], "touches": [], "objects": built["raw"]}))
    .unwrap();
    assert_eq!(again["already"], true);
    // A record that disagrees with its commit object is refused.
    let other = shard();
    let lying = on(
        &other,
        json!({"op": "store_record", "commit": built["commit"], "tree": root,
        "parents": built["parents"], "generation": 2, "base_version": 1, "principal": "x", "message": "m",
        "read_set": [], "touches": [], "objects": built["raw"]}),
    );
    assert_eq!(code(lying), "OBJECT_INVALID");
    let mut outsider = json!({"op": "store_commit", "commit": built["commit"], "now": 1});
    outsider["_token"] = json!("agent-secret-0123456789abcdef0123456789");
    assert_eq!(code(execute_commit_store(&s, outsider)), "FORBIDDEN");
    // Begin needs write scope; only the platform adopts.
    assert_eq!(
        code(h.run(
            CI,
            json!({"op": "repo_begin_commit", "ref": "main", "paths": ["a.txt"]})
        )),
        "FORBIDDEN"
    );
    let record = on(&s, json!({"op": "store_commit", "commit": built["commit"]})).unwrap();
    assert_eq!(
        code(h.run(AGENT, json!({"op": "repo_adopt_commit", "record": record}))),
        "FORBIDDEN"
    );
    // Staged objects serve reads until R2 holds them, as in the authority.
    let read = on(
        &s,
        json!({"op": "store_staged_objects", "ids": [built["commit"]]}),
    )
    .unwrap();
    assert_eq!(read["objects"].as_array().unwrap().len(), 1);
    // A whole commit's staged objects at once (batch merges prefetch their inputs).
    let all = on(
        &s,
        json!({"op": "store_staged_objects", "commit": built["commit"]}),
    )
    .unwrap();
    let ids = |v: &Value| {
        let mut ids: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o["id"].to_string())
            .collect();
        ids.sort();
        ids
    };
    assert_eq!(ids(&all["objects"]), ids(&built["objects"]));
}
