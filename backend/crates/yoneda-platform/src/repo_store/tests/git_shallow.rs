//! Shallow and partial fetches at the authority (`repo_git_walk` with `depth`, `shallows`
//! and `objects`): a depth cuts the walk at boundary commits sent with their whole trees,
//! `deepen-relative` counts from the client's shallow commits and unshallows them, the
//! client's shallow commits stop what it is known to hold, and a fetch may want a commit
//! (or, in version 2, a blob by id) only when a branch or tag reaches it.
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
    // On a branch, so a fetch may want them.
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{ "ref": "topic", "commit": ids[5], "expected": null }]}),
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
    batch(json!([{ "ref": "other", "commit": hidden, "expected": null }]));
    assert_eq!(
        walk(json!([unreached])).unwrap()["objects"],
        json!([unreached])
    );
    batch(json!([{ "ref": "other", "commit": null, "expected": hidden }]));
    assert_eq!(code(walk(json!([unreached]))), "NOT_FOUND");
    // A version 0 fetch still wants commits only.
    let v0 = h.run(
        AGENT,
        json!({"op":"repo_git_walk","wants":[seeded[0]],"haves":[]}),
    );
    assert_eq!(code(v0), "NOT_FOUND");
}

#[test]
fn a_fetch_may_want_only_commits_a_branch_or_tag_reaches() {
    let (h, c, _) = chain();
    let walk = |wants: Value, extra: Value| {
        let mut command = json!({"op":"repo_git_walk","wants":wants,"haves":[]});
        command
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        h.run(AGENT, command)
    };
    // A tip and an ancestor of one, in v0 and v2, negotiation rounds too.
    for extra in [
        json!({}),
        json!({"objects": true}),
        json!({"common_only": true}),
    ] {
        walk(json!([c[5], c[2]]), extra.clone()).unwrap();
    }
    // A commit recorded but never on a ref (a push refused at its ref move records its
    // commits) is not ours, whatever the protocol.
    let refused = h
        .commit(
            AGENT,
            Some(&c[5]),
            1,
            json!([file("x.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    for extra in [
        json!({}),
        json!({"objects": true}),
        json!({"common_only": true}),
    ] {
        let err = walk(json!([c[5], refused]), extra).unwrap_err();
        assert_eq!(err.code, "NOT_FOUND");
        assert_eq!(err.message, format!("upload-pack: not our ref {refused}"));
    }
    // Once its branch is deleted, nothing reaches c1..c5 either.
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{ "ref": "topic", "commit": null, "expected": c[5] }]}),
    );
    assert_eq!(code(walk(json!([c[3]]), json!({}))), "NOT_FOUND");
    assert!(walk(json!([c[0]]), json!({})).is_ok(), "main's root");
}

#[test]
fn a_version_2_fetch_may_want_more_objects_than_a_version_0_one() {
    let (h, c, _) = chain();
    let file =
        h.ok(OWNER, json!({"op":"repo_commit","commit":c[0]}))["paths"][0]["new_blob"].clone();
    let wants = |n: usize, objects: bool| {
        let mut wants = vec![json!(c[5]); 1];
        wants.extend(std::iter::repeat_n(file.clone(), n));
        h.run(
            AGENT,
            json!({"op":"repo_git_walk","wants":wants,"haves":[],"objects":objects}),
        )
    };
    // A checkout of more than 10,000 files wants each one in a single request.
    let many = wants(12_000, true).unwrap();
    assert_eq!(many["objects"].as_array().unwrap().len(), 12_000);
    assert_eq!(code(wants(100_000, true)), "TOO_LARGE");
    assert_eq!(code(wants(12_000, false)), "TOO_LARGE");
}
