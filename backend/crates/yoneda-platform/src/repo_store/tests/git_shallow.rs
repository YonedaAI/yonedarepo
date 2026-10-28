//! Shallow and partial fetches at the authority (`repo_git_walk` with `depth`, `shallows`
//! and `objects`): a depth cuts the walk at boundary commits sent with their whole trees,
//! `deepen-relative` counts from the client's shallow commits and unshallows them, the
//! client's shallow commits stop what it is known to hold, and a version 2 fetch may want
//! a blob by id.
use super::*;
use yoneda_core::git_object::{ObjectId, Signature};

/// main's root then five pushed commits on top, oldest first: `[root, c1, …, c5]`.
fn chain() -> (Harness, Vec<String>, String) {
    let (h, root) = seeded();
    let tree = h.ok(
        OWNER,
        json!({"op":"repo_commit","commit":root,"brief":true}),
    )["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let who = Signature {
        name: "Dev".into(),
        email: "dev@example.com".into(),
        seconds: 1_700_000_000,
        offset: "+0000".into(),
    };
    let mut ids = vec![root];
    let mut items = Vec::new();
    for n in 1..=5 {
        let parent = ObjectId::parse(ids.last().unwrap()).unwrap();
        let commit = Commit::new(
            ObjectId::parse(&tree).unwrap(),
            &[parent],
            &who,
            &who,
            &format!("c{n}"),
        )
        .unwrap();
        let id = commit.id().hex();
        items.push(
            json!({ "commit": id, "data_b64": STANDARD.encode(commit.encode()),
                           "touches": [], "objects": [{ "id": id, "kind": "commit" }] }),
        );
        ids.push(id);
    }
    h.ok(
        AGENT,
        json!({ "op": "repo_record_pushed", "commits": items }),
    );
    (h, ids, tree)
}

fn sent(walk: &Value) -> Vec<String> {
    walk["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["commit"].as_str().unwrap().to_owned())
        .collect()
}

fn base(walk: &Value, commit: &str) -> Value {
    walk["commits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["commit"] == commit)
        .map(|c| c["base_tree"].clone())
        .unwrap()
}

#[test]
fn depth_cuts_the_walk_at_boundaries_sent_whole() {
    let (h, c, tree) = chain();
    let walk = |args: Value| {
        let mut command = json!({"op":"repo_git_walk","wants":[c[5]],"haves":[]});
        command
            .as_object_mut()
            .unwrap()
            .extend(args.as_object().unwrap().clone());
        h.ok(AGENT, command)
    };
    // --depth 1: the tip alone, shallow, with its whole tree.
    let one = walk(json!({"depth": 1}));
    assert_eq!(sent(&one), [c[5].clone()]);
    assert_eq!(one["shallow"], json!([c[5]]));
    assert_eq!(one["unshallow"], json!([]));
    assert_eq!(base(&one, &c[5]), Value::Null);
    // --depth 3: three commits; only the deepest is a boundary.
    let three = walk(json!({"depth": 3}));
    assert_eq!(sent(&three), [c[5].clone(), c[4].clone(), c[3].clone()]);
    assert_eq!(three["shallow"], json!([c[3]]));
    assert_eq!(base(&three, &c[4]), json!(tree));
    assert_eq!(base(&three, &c[3]), Value::Null);
    // A depth past the root: everything, nothing shallow (a root has no parents to cut).
    let all = walk(json!({"depth": 50}));
    assert_eq!(sent(&all).len(), 6);
    assert_eq!(all["shallow"], json!([]));
    // No depth: the whole history, as before.
    assert_eq!(sent(&walk(json!({}))).len(), 6);
}

#[test]
fn deepen_relative_counts_from_the_client_shallows_and_unshallows_them() {
    let (h, c, tree) = chain();
    // The client cloned --depth 3 (holds c5..c3, shallow at c3); `git fetch --deepen 2`.
    let deeper = h.ok(
        AGENT,
        json!({"op":"repo_git_walk","wants":[c[5]],"haves":[c[5]],"shallows":[c[3]],
               "depth":2,"deepen_relative":true}),
    );
    assert_eq!(sent(&deeper), [c[2].clone(), c[1].clone()]);
    assert_eq!(deeper["unshallow"], json!([c[3]]));
    assert_eq!(deeper["shallow"], json!([c[1]]));
    assert_eq!(base(&deeper, &c[2]), json!(tree));
    assert_eq!(base(&deeper, &c[1]), Value::Null);
    // --unshallow: everything below the shallow commit, nothing shallow after.
    let full = h.ok(
        AGENT,
        json!({"op":"repo_git_walk","wants":[c[5]],"haves":[c[5]],"shallows":[c[3]],
               "depth":yoneda_core::git_object::INFINITE_DEPTH}),
    );
    assert_eq!(sent(&full), [c[2].clone(), c[1].clone(), c[0].clone()]);
    assert_eq!(full["unshallow"], json!([c[3]]));
    assert_eq!(full["shallow"], json!([]));
}

#[test]
fn client_shallows_bound_what_it_holds() {
    let (h, c, _) = chain();
    // Shallow at c4, holding c4 only: a plain fetch of c5 sends c5, and nothing below c4
    // counts as held, so --depth 3 from c5 sends c3 (c4's parent) too.
    let plain = h.ok(
        AGENT,
        json!({"op":"repo_git_walk","wants":[c[5]],"haves":[c[4]],"shallows":[c[4]]}),
    );
    assert_eq!(sent(&plain), [c[5].clone()]);
    assert_eq!(plain["unshallow"], json!([]));
    let three = h.ok(
        AGENT,
        json!({"op":"repo_git_walk","wants":[c[5]],"haves":[c[4]],"shallows":[c[4]],"depth":3}),
    );
    assert_eq!(sent(&three), [c[5].clone(), c[3].clone()]);
    assert_eq!(three["shallow"], json!([c[3]]));
    assert_eq!(three["unshallow"], json!([c[4]]));
}

#[test]
fn a_version_2_fetch_may_want_only_blobs_a_branch_or_tag_reaches() {
    let (h, c, _) = chain();
    let walk = |wants: Value| {
        h.run(
            AGENT,
            json!({"op":"repo_git_walk","wants":wants,"haves":[],"objects":true}),
        )
    };
    // The seed's files are on main (introduced by its root).
    let seeded: Vec<String> = h.ok(OWNER, json!({"op":"repo_commit","commit":c[0]}))["paths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["new_blob"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(seeded.len(), 2);
    let served = walk(json!(seeded)).unwrap();
    assert_eq!(served["objects"], json!(seeded));
    assert_eq!(sent(&served), Vec::<String>::new());
    // An id no recorded commit introduces is not ours, nor a commit only a refused or
    // deleted branch held (c1..c5 were recorded but never on a ref).
    let err = walk(json!(["e".repeat(40)])).unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");
    assert!(err.message.contains("not our ref"), "{}", err.message);
    let commit = |parent: &str, path: &str, text: &str| {
        h.commit(AGENT, Some(parent), 1, json!([file(path, text)]), json!([]))
            .unwrap()
    };
    let hidden = commit(&c[0], "hidden.txt", "never on a ref\n");
    let blob = |commit: &str| {
        h.ok(OWNER, json!({"op":"repo_commit","commit":commit}))["paths"][0]["new_blob"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let unreached = blob(&hidden);
    assert_eq!(code(walk(json!([unreached]))), "NOT_FOUND");
    // Reached through a branch: served; once the branch is deleted, not.
    let batch = |updates: Value| h.ok(AGENT, json!({"op":"repo_branch_batch","updates":updates}));
    batch(json!([{ "ref": "topic", "commit": hidden, "expected": null }]));
    assert_eq!(
        walk(json!([unreached])).unwrap()["objects"],
        json!([unreached])
    );
    batch(json!([{ "ref": "topic", "commit": null, "expected": hidden }]));
    assert_eq!(code(walk(json!([unreached]))), "NOT_FOUND");
    // A version 0 fetch still wants commits only.
    let v0 = h.run(
        AGENT,
        json!({"op":"repo_git_walk","wants":[seeded[0]],"haves":[]}),
    );
    assert_eq!(code(v0), "NOT_FOUND");
}
