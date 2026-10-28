//! Git over HTTPS at the authority: pushed commits are recorded under their own ids (bytes
//! checked against the id, parents recorded, base version derived here), branches delete by
//! compare-and-swap, a fetch walks only what the client lacks, and access refuses a token
//! without the service's scope or with a path grant.
use super::*;
use yoneda_core::git_object::{ObjectId, Signature, TzOffset};

fn pushed(parent: &str, tree: &str, message: &str) -> (String, Value) {
    let who = Signature {
        name: "Dev".into(),
        email: "dev@example.com".into(),
        seconds: 1_700_000_000,
        offset: TzOffset::UTC,
    };
    let commit = Commit::new(
        ObjectId::parse(tree).unwrap(),
        &[ObjectId::parse(parent).unwrap()],
        &who,
        &who,
        message,
    )
    .unwrap();
    let id = commit.id().hex();
    let item = json!({ "commit": id, "data_b64": STANDARD.encode(commit.encode()), "touches": [],
                       "objects": [{ "id": id, "kind": "commit" }] });
    (id, item)
}

fn record(h: &Harness, who: &str, commits: Value) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({ "op": "repo_record_pushed", "commits": commits }),
    )
}

#[test]
fn pushed_commits_keep_their_ids_and_branches_delete_by_compare_and_swap() {
    let (h, root) = seeded();
    let tree = h.ok(
        OWNER,
        json!({"op":"repo_commit","commit":root,"brief":true}),
    )["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let (first, item) = pushed(&root, &tree, "first");
    let (second, next) = pushed(&first, &tree, "second");
    assert_eq!(code(record(&h, CI, json!([item]))), "FORBIDDEN");
    let mut forged = item.clone();
    forged["commit"] = json!("f".repeat(40));
    assert_eq!(
        code(record(&h, AGENT, json!([forged]))),
        "GIT_OBJECT_INVALID"
    );
    // Parents first: a commit whose parent is not recorded is refused, and nothing is.
    assert_eq!(code(record(&h, AGENT, json!([next]))), "NOT_FOUND");
    let recorded = record(&h, AGENT, json!([item, next])).unwrap();
    assert_eq!(recorded["recorded"], 2);
    assert_eq!(
        record(&h, AGENT, json!([item, next])).unwrap()["recorded"],
        0
    );
    for id in [&first, &second] {
        let shown = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
        assert_eq!(shown["principal"], AGENT);
        // Based where main took its first parent (the root landed at version 1).
        assert_eq!(shown["base_version"], 1);
    }

    let batch = |updates: Value| h.run(AGENT, json!({"op":"repo_branch_batch","updates":updates}));
    batch(json!([{ "ref": "feature", "commit": second, "expected": null }])).unwrap();
    let stale = batch(json!([{ "ref": "feature", "commit": null, "expected": first }])).unwrap();
    assert_eq!(stale["stale"], json!(["refs/heads/feature"]));
    let deleted = batch(json!([{ "ref": "feature", "commit": null, "expected": second }])).unwrap();
    assert_eq!(deleted["refs"][0]["deleted"], true);
    let version = deleted["version"].as_u64().unwrap();
    assert!(
        h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]
            .get("refs/heads/feature")
            .is_none()
    );
    let then = h.ok(OWNER, json!({"op":"repo_refs","at":version - 1}));
    assert_eq!(then["refs"]["refs/heads/feature"], second);
    let log = h.ok(
        OWNER,
        json!({"op":"repo_txlog","after":version - 1,"limit":1}),
    );
    assert_eq!(log["entries"][0]["kind"], "ref_delete");
    let main = batch(json!([{ "ref": "main", "commit": null, "expected": root }]));
    assert_eq!(code(main), "FORBIDDEN");

    // `second` is on no branch now: a fetch may not want it. Back on one, a fetch of it by
    // a client holding the root sends both pushed commits.
    let hidden = h.run(
        AGENT,
        json!({"op":"repo_git_walk","wants":[second],"haves":[root]}),
    );
    assert_eq!(code(hidden), "NOT_FOUND");
    batch(json!([{ "ref": "feature", "commit": second, "expected": null }])).unwrap();
    let walk = h.ok(
        AGENT,
        json!({"op":"repo_git_walk","wants":[second],"haves":[root, "e".repeat(40)]}),
    );
    let sent: Vec<_> = walk["commits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["commit"].clone())
        .collect();
    assert_eq!(sent, [json!(second), json!(first)]);
    assert_eq!(walk["commits"][1]["base_tree"], tree);
    assert_eq!(walk["common"], json!([root]));
    let common = h.ok(
        AGENT,
        json!({"op":"repo_git_walk","wants":[second],"haves":[first],"common_only":true}),
    );
    assert_eq!(common, json!({ "common": [first] }));
    let unknown = h.run(
        AGENT,
        json!({"op":"repo_git_walk","wants":["e".repeat(40)],"haves":[]}),
    );
    assert_eq!(code(unknown), "NOT_FOUND");
}

#[test]
fn git_access_follows_the_service_scope_and_refuses_path_grants() {
    let (h, _) = seeded();
    let access =
        |who: &str, service: &str| h.run(who, json!({"op":"repo_git_access","service":service}));
    assert_eq!(
        access(CI, "git-upload-pack").unwrap()["object_store"],
        "artifacts:test/demo"
    );
    assert_eq!(code(access(CI, "git-receive-pack")), "FORBIDDEN");
    assert_eq!(code(access(AGENT, "git-receive-pack")), "OK");
    assert_eq!(code(access(AGENT, "dumb")), "INVALID_INPUT");
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(code(access("token:docs", "git-upload-pack")), "FORBIDDEN");
    let walk = h.run(
        "token:docs",
        json!({"op":"repo_git_walk","wants":[],"haves":[]}),
    );
    assert_eq!(code(walk), "FORBIDDEN");
}

#[test]
fn a_small_push_is_staged_with_its_commits_and_drained_to_the_store_afterwards() {
    const PROJECTOR: &str = "platform:projection";
    let (h, root) = seeded();
    let tree = h.ok(
        OWNER,
        json!({"op":"repo_commit","commit":root,"brief":true}),
    )["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let (first, mut item) = pushed(&root, &tree, "staged push");
    item["objects"][0]["data_b64"] = item["data_b64"].clone();
    let blob = b"pushed file\n";
    let blob_id = hash_object(ObjectKind::Blob, blob).hex();
    item["objects"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "id": blob_id, "kind": "blob", "data_b64": STANDARD.encode(blob) }));
    let staged = |item: &Value| {
        h.run(
            AGENT,
            json!({ "op": "repo_record_pushed", "commits": [item], "staged": true }),
        )
    };

    // Bytes that do not hash to their listed id refuse the push, and nothing is recorded.
    let mut forged = item.clone();
    forged["objects"][1]["data_b64"] = json!(STANDARD.encode(b"other bytes\n"));
    assert_eq!(code(staged(&forged)), "GIT_OBJECT_INVALID");
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_commit","commit":first}))),
        "NOT_FOUND"
    );

    let recorded = staged(&item).unwrap();
    assert_eq!(recorded["recorded"], 1);
    assert_eq!(recorded["dispatch_objects"], true);
    // Readable by id before the store holds them; the outbox lists them for the drain.
    let read = h.ok(
        PROJECTOR,
        json!({"op":"repo_staged_objects","ids":[first, blob_id],"raw":true}),
    );
    assert_eq!(read["objects"].as_array().unwrap().len(), 2);
    let pending = h.ok(PROJECTOR, json!({"op":"repo_objects_pending"}));
    assert_eq!(pending["commits"][0]["commit"], first);
    assert_eq!(
        pending["commits"][0]["objects"].as_array().unwrap().len(),
        2
    );
    // A repeated push records and stages nothing again.
    let again = staged(&item).unwrap();
    assert_eq!(again["recorded"], 0);
    assert_eq!(again["dispatch_objects"], false);
    // Confirmed in the store: the staged copies go.
    h.ok(
        PROJECTOR,
        json!({"op":"repo_objects_projected","results":[{"commit":first,"outcome":"ok"}]}),
    );
    let gone = h.ok(
        PROJECTOR,
        json!({"op":"repo_staged_objects","ids":[first, blob_id]}),
    );
    assert_eq!(gone["objects"], json!([]));
}

/// A push's declared reads (`-o yoneda.reads=…`) travel with its tip: landing refuses it
/// as a stale read once a read file was written concurrently, while the same work without
/// the declaration only needs a merge. Reads accumulate per pusher until the commit lands.
#[test]
fn a_pushed_tip_keeps_its_declared_reads_and_landing_validates_them() {
    let (h, root) = seeded();
    let tree = h.ok(
        OWNER,
        json!({"op":"repo_commit","commit":root,"brief":true}),
    )["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    // A teammate changes README.md on main after the push's base (version 1).
    let theirs = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("README.md", "# changed\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&theirs);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":theirs}),
    );

    let (reader, mut item) = pushed(&root, &tree, "relied on the readme");
    item["read_set"] = json!(["README.md", "src/"]);
    item["check"] = json!(true);
    let mut bad = item.clone();
    bad["read_set"] = json!(["../outside"]);
    assert_eq!(code(record(&h, AGENT, json!([bad]))), "INVALID_INPUT");
    record(&h, AGENT, json!([item])).unwrap();
    let shown = h.ok(OWNER, json!({"op":"repo_commit","commit":reader}));
    assert_eq!(shown["read_set"], json!(["README.md", "src/"]));
    // Someone else cannot add reads; the pusher can, and they accumulate.
    let mut more = item.clone();
    more["read_set"] = json!(["Cargo.toml"]);
    record(&h, OWNER, json!([more.clone()])).unwrap();
    let shown = h.ok(OWNER, json!({"op":"repo_commit","commit":reader}));
    assert_eq!(shown["read_set"], json!(["README.md", "src/"]));
    record(&h, AGENT, json!([more])).unwrap();
    let shown = h.ok(OWNER, json!({"op":"repo_commit","commit":reader}));
    assert_eq!(
        shown["read_set"],
        json!(["Cargo.toml", "README.md", "src/"])
    );
    h.approve_and_check(&reader);
    let refused = h
        .run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":reader}),
        )
        .unwrap_err();
    assert_eq!(refused.code, "CONFLICT");
    assert!(
        refused
            .message
            .contains("README.md, which this commit read"),
        "{}",
        refused.message
    );

    // The same work declaring nothing is independent of the teammate's change: a merge.
    let (blind, item) = pushed(&root, &tree, "declared nothing");
    record(&h, AGENT, json!([item])).unwrap();
    h.approve_and_check(&blind);
    let merge = h
        .run(OWNER, json!({"op":"repo_land","ref":"main","commit":blind}))
        .unwrap_err();
    assert_eq!(merge.code, "MERGE_REQUIRED");
}
