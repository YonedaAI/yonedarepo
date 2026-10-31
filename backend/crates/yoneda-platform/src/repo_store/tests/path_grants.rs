//! A path grant covers every commit a landing would bring onto the ref, not the head alone,
//! on every landing path. Anything it cannot prove inside the grant (a merge, a parent not
//! recorded, a commit with no recorded paths, a walk past its bound) is refused.
use super::batches::{credentials, open, outcome};
use super::*;
use crate::repo_store::grants::{self, Grant};
use crate::repo_store::land_gates::WALK;
use crate::repo_store::op::{RepoOp, StoreOp};
use crate::storage::SqlStore;

pub(super) const DOCS: &str = "token:docs";
const MERGER: &str = "platform:merge";
pub(super) const MISSING: &str = "0123456789abcdef0123456789abcdef01234567";

/// Open policy (gates are covered elsewhere), plus a token limited to `docs/`.
pub(super) fn repo() -> (Harness, String) {
    let (h, root) = open();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write","land","review","check"],
        "paths":["docs/"],"_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    (h, root)
}

pub(super) fn commit(h: &Harness, who: &str, parent: &str, path: &str) -> String {
    h.commit(who, Some(parent), 1, json!([file(path, "x\n")]), json!([]))
        .unwrap()
}

/// `git_land` as the adapter sends it, and the queued forms of the same landing.
fn landings(id: &str, refname: &str) -> [Value; 3] {
    [
        json!({"op":"repo_land","ref":refname,"commit":id}),
        json!({"op":"repo_land","ref":refname,"commit":id,"enqueue":true}),
        json!({"op":"repo_land_enqueue","ref":refname,"commit":id}),
    ]
}

fn assert_refused_everywhere(h: &Harness, id: &str, refname: &str) {
    for landing in landings(id, refname) {
        let refused = h.run(DOCS, landing.clone()).unwrap_err();
        assert_eq!(
            (refused.code.as_str(), refused.message.as_str()),
            ("FORBIDDEN", "Path is outside your grant"),
            "{landing}"
        );
    }
}

fn landed_on(h: &Harness, id: &str) -> Value {
    h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["landings"].clone()
}

fn main_head(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_refs"}))["refs"]["refs/heads/main"].clone()
}

/// A shard record of a commit on `parent`'s record, as `shardChain` would hold it.
fn stacked(h: &Harness, who: &str, parent: &Value, path: &str) -> Value {
    let on = &parent["commit"];
    let begun = json!({"parent": {"id": on["id"], "tree": on["tree"], "generation": on["generation"]},
        "base_version": on["base_version"], "principal": who});
    h.shard_commit_from(&begun, path, "x\n", json!([]))
}

/// A shard record of a commit by `who` on recorded commit `parent`.
fn shard_on(h: &Harness, who: &str, parent: &str, path: &str) -> Value {
    let row = h.ok(OWNER, json!({"op":"repo_commit","commit":parent}));
    let begun = json!({"parent": {"id": parent, "tree": row["tree"], "generation": row["generation"]},
        "base_version": 1, "principal": who});
    h.shard_commit_from(&begun, path, "x\n", json!([]))
}

fn submit_chain(h: &Harness, who: &str, records: &[&Value]) -> Value {
    let items = vec![json!({"credentials": credentials(who), "records": records})];
    h.ok(
        MERGER,
        json!({"op":"repo_land_submitted","ref":"main","items":items}),
    )
}

fn refused(batch: &Value) -> (String, Value) {
    let (status, item) = outcome(batch, 0);
    (status, item["code"].clone())
}

const FORBIDDEN: fn() -> (String, Value) = || ("failed".into(), json!("FORBIDDEN"));

#[test]
fn a_commit_outside_the_grant_under_the_head_is_refused_on_every_path() {
    let (h, root) = repo();
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    let head = commit(&h, DOCS, &src, "docs/a.md");
    // The commit below is refused alone, and the commit on top no longer launders it.
    assert_refused_everywhere(&h, &src, "main");
    assert_refused_everywhere(&h, &head, "main");
    assert_eq!(landed_on(&h, &head), json!([]));
    assert_eq!(main_head(&h), json!(root));

    // Nothing changed for a caller of the whole repository.
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":head}))),
        "OK"
    );
    assert_eq!(h.file_at(&head, "src/retry.rs").as_deref(), Some("x\n"));
}

#[test]
fn a_working_branch_and_a_release_are_judged_against_themselves() {
    let (h, root) = repo();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"work","commit":root,"expected":null}]}),
    );
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"release/1","commit":root}),
    );
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    let head = commit(&h, DOCS, &src, "docs/a.md");
    assert_refused_everywhere(&h, &head, "work");
    // Main having the code is no reason to carry it to a release that does not.
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":src}));
    assert_eq!(
        code(h.run(DOCS, json!({"op":"repo_land","ref":"main","commit":head}))),
        "OK"
    );
    assert_refused_everywhere(&h, &head, "release/1");
    assert_refused_everywhere(&h, &head, "work");
}

#[test]
fn a_submitted_chain_with_a_commit_outside_the_grant_is_refused() {
    let (h, _) = repo();
    let src = h.shard_commit(AGENT, "src/retry.rs", "x\n", json!([]));
    let head = stacked(&h, DOCS, &src, "docs/a.md");
    // The authority does not have what lies below: it asks before judging, and lands nothing.
    assert_eq!(outcome(&h.submit(vec![(DOCS, &head)]), 0).0, "need_chain");
    let chain = submit_chain(&h, DOCS, &[&src, &head]);
    assert_eq!(refused(&chain), FORBIDDEN(), "{chain}");
    let id = head["commit"]["id"].as_str().unwrap();
    assert_eq!(landed_on(&h, id), json!([]));
    assert_eq!(
        h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}))["empty"],
        true,
        "nothing queued"
    );
    // Adopted by that attempt, the chain is now refused from the tip's record alone.
    assert_eq!(refused(&h.submit(vec![(DOCS, &head)])), FORBIDDEN());
}

#[test]
fn a_submitted_commit_on_a_recorded_outside_commit_is_refused() {
    let (h, root) = repo();
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    let head = shard_on(&h, DOCS, &src, "docs/a.md");
    assert_eq!(refused(&h.submit(vec![(DOCS, &head)])), FORBIDDEN());
    assert_eq!(main_head(&h), json!(root));
    // The same landing by a caller of the whole repository still queues.
    assert_eq!(outcome(&h.submit(vec![(OWNER, &head)]), 0).0, "queued");
}

#[test]
fn work_inside_the_grant_lands_on_every_path() {
    let (h, root) = repo();
    let first = commit(&h, DOCS, &root, "docs/a.md");
    let second = commit(&h, DOCS, &first, "docs/b.md");
    assert_eq!(
        code(h.run(DOCS, json!({"op":"repo_land","ref":"main","commit":second}))),
        "OK"
    );
    // A retried landing answers, whatever is under it.
    assert_eq!(
        h.ok(DOCS, json!({"op":"repo_land","ref":"main","commit":second}))["already"],
        true
    );
    let on_first = commit(&h, DOCS, &first, "docs/c.md");
    assert_eq!(
        code(h.run(
            DOCS,
            json!({"op":"repo_land_enqueue","ref":"main","commit":on_first})
        )),
        "OK"
    );

    let (h, _) = repo();
    let lone = h.shard_commit(DOCS, "docs/a.md", "a\n", json!([]));
    assert_eq!(outcome(&h.submit(vec![(DOCS, &lone)]), 0).0, "landed");
    let again = h.submit(vec![(DOCS, &lone)]);
    assert_eq!(outcome(&again, 0).1["already"], true);
    let first = h.shard_commit(DOCS, "docs/b.md", "b\n", json!([]));
    let second = stacked(&h, DOCS, &first, "docs/c.md");
    assert_eq!(outcome(&h.submit(vec![(DOCS, &second)]), 0).0, "need_chain");
    let chain = submit_chain(&h, DOCS, &[&first, &second]);
    assert_eq!(outcome(&chain, 0).0, "queued", "{chain}");
}

#[test]
fn a_submitted_commit_on_a_landed_changeset_lands() {
    let (h, _) = repo();
    let first = h.shard_commit(DOCS, "docs/a.md", "a\n", json!([]));
    assert_eq!(outcome(&h.submit(vec![(DOCS, &first)]), 0).0, "landed");
    let second = stacked(&h, DOCS, &first, "docs/b.md");
    // The landed commit may live only in its shard: the walk stops at it either way.
    assert_eq!(outcome(&h.submit(vec![(DOCS, &second)]), 0).0, "need_chain");
    let chain = submit_chain(&h, DOCS, &[&first, &second]);
    assert_ne!(refused(&chain), FORBIDDEN(), "{chain}");
}

#[test]
fn what_the_ref_already_has_is_not_judged() {
    let (h, root) = repo();
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":src}));
    let on_head = commit(&h, DOCS, &src, "docs/a.md");
    assert_eq!(
        code(h.run(
            DOCS,
            json!({"op":"repo_land","ref":"main","commit":on_head})
        )),
        "OK"
    );
    // On an older commit of the ref: past the grant, landing routes it as ever.
    let behind = commit(&h, DOCS, &src, "docs/b.md");
    let on_root = commit(&h, DOCS, &root, "docs/c.md");
    for id in [&behind, &on_root] {
        assert_eq!(
            code(h.run(DOCS, json!({"op":"repo_land","ref":"main","commit":id}))),
            "MERGE_REQUIRED"
        );
    }
    let shard = shard_on(&h, DOCS, &src, "docs/d.md");
    assert_eq!(outcome(&h.submit(vec![(DOCS, &shard)]), 0).0, "queued");
}

#[test]
fn a_merge_is_refused_as_the_head_and_on_the_way() {
    let (h, root) = repo();
    let side = commit(&h, DOCS, &root, "docs/side.md");
    let merge = h
        .commit_with(
            DOCS,
            Some(&root),
            1,
            json!([file("docs/m.md", "x\n")]),
            json!([]),
            json!({"merge_parent": side}),
        )
        .unwrap();
    assert_refused_everywhere(&h, &merge, "main");
    let above = commit(&h, DOCS, &merge, "docs/above.md");
    assert_refused_everywhere(&h, &above, "main");
    let shard = shard_on(&h, DOCS, &merge, "docs/shard.md");
    assert_eq!(refused(&h.submit(vec![(DOCS, &shard)])), FORBIDDEN());
    // A merge the ref already has proves its own history.
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":merge}));
    let tip = commit(&h, DOCS, &merge, "docs/tip.md");
    assert_eq!(
        code(h.run(DOCS, json!({"op":"repo_land","ref":"main","commit":tip}))),
        "OK"
    );
}

#[test]
fn a_parent_not_recorded_is_refused() {
    let (h, root) = repo();
    let mid = commit(&h, DOCS, &root, "docs/a.md");
    let head = commit(&h, DOCS, &mid, "docs/b.md");
    let shard = shard_on(&h, DOCS, &head, "docs/c.md");
    h.db.query("DELETE FROM commits WHERE id=?", &[json!(mid)])
        .unwrap();
    assert_refused_everywhere(&h, &head, "main");
    assert_refused_everywhere(&h, shard["commit"]["id"].as_str().unwrap(), "main");
    assert_eq!(refused(&h.submit(vec![(DOCS, &shard)])), FORBIDDEN());
}

#[test]
fn a_commit_with_no_recorded_paths_is_refused() {
    let (h, root) = repo();
    let mid = commit(&h, DOCS, &root, "docs/a.md");
    let head = commit(&h, DOCS, &mid, "docs/b.md");
    let shard = shard_on(&h, DOCS, &head, "docs/c.md");
    h.db.query("DELETE FROM commit_paths WHERE commit_id=?", &[json!(mid)])
        .unwrap();
    assert_refused_everywhere(&h, &mid, "main");
    assert_refused_everywhere(&h, &head, "main");
    assert_eq!(refused(&h.submit(vec![(DOCS, &shard)])), FORBIDDEN());

    let (h, _) = repo();
    let mut empty = h.shard_commit(DOCS, "docs/a.md", "a\n", json!([]));
    empty["paths"] = json!([]);
    assert_eq!(refused(&h.submit(vec![(DOCS, &empty)])), FORBIDDEN());
}

#[test]
fn a_commit_that_does_not_exist_is_refused_like_one_that_does() {
    let (h, _) = repo();
    assert_refused_everywhere(&h, MISSING, "main");
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":MISSING})
        )),
        "NOT_FOUND"
    );
}

#[test]
fn the_walk_is_bounded_and_refuses_past_it() {
    let (h, root) = repo();
    let mut tip = root;
    for i in 0..WALK {
        tip = commit(&h, DOCS, &tip, &format!("docs/{i}.md"));
    }
    let past = commit(&h, DOCS, &tip, "docs/past.md");
    assert_refused_everywhere(&h, &past, "main");
    let shard = shard_on(&h, DOCS, &past, "docs/shard.md");
    assert_eq!(refused(&h.submit(vec![(DOCS, &shard)])), FORBIDDEN());
    assert_eq!(
        code(h.run(DOCS, json!({"op":"repo_land","ref":"main","commit":tip}))),
        "OK",
        "at the bound"
    );
}

#[test]
fn a_new_branch_is_judged_on_all_it_would_hold() {
    let (h, root) = repo();
    let docs = commit(&h, DOCS, &root, "docs/a.md");
    // `root` wrote README.md and src/: a branch made by this landing would bring them.
    for landing in landings(&docs, "work") {
        let refused = h.run(DOCS, landing).unwrap_err();
        assert_eq!(refused.code, "FORBIDDEN");
        assert!(
            refused.message.contains("create the branch first"),
            "{}",
            refused.message
        );
    }
    // Nothing to create first on a protected ref, nor anything to tell about a hidden head.
    assert_refused_everywhere(&h, &docs, "release/1");
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    assert_refused_everywhere(&h, &src, "work");
    // Made by a branch move at the base, the same landing has only `docs` to bring.
    h.ok(
        DOCS,
        json!({"op":"repo_branch_batch","updates":[{"ref":"work","commit":root,"expected":null}]}),
    );
    assert_eq!(
        code(h.run(DOCS, json!({"op":"repo_land","ref":"work","commit":docs}))),
        "OK"
    );
}

#[test]
fn reviews_and_checks_cover_what_the_head_would_bring() {
    let (h, root) = repo();
    let src = commit(&h, AGENT, &root, "src/retry.rs");
    let head = commit(&h, AGENT, &src, "docs/a.md");
    let approve = json!({"op":"repo_review","commit":head,"decision":"approve"});
    let check = json!({"op":"repo_check","commit":head,"name":"unit","status":"pass"});
    let request = json!({"op":"repo_check_request","commit":head,"name":"unit"});
    for command in [approve, check, request] {
        assert_eq!(code(h.run(DOCS, command.clone())), "FORBIDDEN", "{command}");
    }
    let inside = commit(&h, AGENT, &root, "docs/b.md");
    h.ok(
        DOCS,
        json!({"op":"repo_review","commit":inside,"decision":"approve"}),
    );
    // Not here yet is the adapter's cue to adopt the commit and retry.
    assert_eq!(
        code(h.run(
            DOCS,
            json!({"op":"repo_review","commit":MISSING,"decision":"approve"})
        )),
        "NOT_FOUND"
    );
}

#[test]
fn a_caller_of_the_whole_repository_pays_for_no_walk() {
    let (h, root) = repo();
    let whole: Grant = None;
    let before = h.db.counts();
    for op in [
        RepoOp::Land,
        RepoOp::LandEnqueue,
        RepoOp::Review,
        RepoOp::BranchSet,
        RepoOp::BranchBatch,
        RepoOp::TagCreate,
    ] {
        let c = json!({"ref":"main","name":"v1","commit":root,
            "updates":[{"ref":"work","commit":root}]});
        grants::precheck(&h.db, StoreOp::Repo(op), &c, &whole).unwrap();
    }
    assert_eq!(h.db.counts(), before);
}
