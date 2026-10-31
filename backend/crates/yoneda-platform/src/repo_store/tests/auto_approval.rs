//! Semantic auto-approval covers every commit a landing would bring onto the ref, not the
//! head alone, on every landing path. Anything it cannot prove safe (no class, a merge, a
//! parent not recorded, a walk past its bound) needs a human approval.
use super::batches::{credentials, outcome};
use super::*;
use crate::repo_store::land_gates::WALK;
use crate::storage::SqlStore;

const CLASSIFIER: &str = "platform:derive";
const MERGER: &str = "platform:merge";

/// Protected main, one approval required, docs and comment-only changes auto-approved.
fn repo() -> (Harness, String) {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":1,
        "auto_approve":["comment_only","docs"]}}),
    );
    (h, root)
}

fn classify(h: &Harness, id: &str, path: &str, class: &str) {
    h.ok(
        CLASSIFIER,
        json!({"op":"repo_record_classes","commit":id,"overall":class,
            "files":[{"path":path,"class":class}]}),
    );
}

fn unclassified(h: &Harness, parent: &str, path: &str) -> String {
    h.commit(
        AGENT,
        Some(parent),
        1,
        json!([file(path, "x\n")]),
        json!([]),
    )
    .unwrap()
}

fn classified(h: &Harness, parent: &str, path: &str, class: &str) -> String {
    let id = unclassified(h, parent, path);
    classify(h, &id, path, class);
    id
}

fn gates(h: &Harness, id: &str) -> Value {
    h.ok(OWNER, json!({"op":"repo_commit","commit":id}))["gates"].clone()
}

fn land(h: &Harness, id: &str) -> String {
    code(h.run(OWNER, json!({"op":"repo_land","ref":"main","commit":id})))
}

fn approve(h: &Harness, id: &str) {
    h.ok(
        OWNER,
        json!({"op":"repo_review","commit":id,"decision":"approve"}),
    );
}

#[test]
fn logic_under_a_docs_head_needs_a_human_on_each_path() {
    let (h, root) = repo();
    let logic = classified(&h, &root, "src/retry.rs", "logic");
    let head = classified(&h, &logic, "README.md", "docs");
    assert_eq!(land(&h, &head), "NOT_READY");
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_land_enqueue","ref":"main","commit":head})
        )),
        "NOT_READY"
    );
    let gate = gates(&h, &head);
    assert_eq!(gate["ready"], false);
    assert_eq!(gate["auto_approved"], false);
    assert_eq!(gate["review_class"], "docs", "still the head's own class");

    // A change on the same head reads the same as landing does.
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch",
        "updates":[{"ref":"fix","commit":head,"expected":null}]}),
    );
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Retry"}),
    );
    let change = h.ok(CI, json!({"op":"repo_change_gates","number":1}));
    assert_eq!(change["ready"], false);
    let approvals = change["requirements"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "approvals")
        .unwrap();
    assert_eq!(approvals["state"], "waiting", "{approvals}");

    approve(&h, &head);
    assert_eq!(land(&h, &head), "OK");
    assert_eq!(h.file_at(&head, "src/retry.rs").as_deref(), Some("x\n"));
}

#[test]
fn a_docs_commit_and_a_docs_chain_still_auto_approve() {
    let (h, root) = repo();
    let lone = classified(&h, &root, "README.md", "docs");
    let gate = gates(&h, &lone);
    assert_eq!(
        (&gate["ready"], &gate["auto_approved"]),
        (&json!(true), &json!(true))
    );
    assert_eq!(land(&h, &lone), "OK");
    let first = classified(&h, &lone, "docs/a.md", "docs");
    let second = classified(&h, &first, "src/lib.rs", "comment_only");
    assert_eq!(gates(&h, &second)["auto_approved"], true);
    assert_eq!(land(&h, &second), "OK");
    // Reviewed history below the ref's head is not walked again: a docs commit on logic
    // that already landed is judged by itself.
    let logic = classified(&h, &second, "src/retry.rs", "logic");
    approve(&h, &logic);
    assert_eq!(land(&h, &logic), "OK");
    let docs = classified(&h, &logic, "docs/b.md", "docs");
    assert_eq!(gates(&h, &docs)["auto_approved"], true);
}

#[test]
fn an_unclassified_commit_under_the_head_needs_a_human() {
    let (h, root) = repo();
    let mid = unclassified(&h, &root, "src/retry.rs");
    let head = classified(&h, &mid, "README.md", "docs");
    assert_eq!(gates(&h, &head)["auto_approved"], false);
    assert_eq!(land(&h, &head), "NOT_READY");
}

#[test]
fn a_pushed_commit_under_the_head_needs_a_human() {
    let (h, root) = repo();
    let tree = h.ok(OWNER, json!({"op":"repo_commit","commit":root}))["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let (push, item) = super::pushed::pushed(&root, &tree, "pushed");
    super::pushed::record(&h, OWNER, json!([item])).unwrap();
    let head = classified(&h, &push, "README.md", "docs");
    assert_eq!(gates(&h, &head)["auto_approved"], false);
    assert_eq!(land(&h, &head), "NOT_READY");
}

#[test]
fn a_parent_not_recorded_needs_a_human() {
    let (h, root) = repo();
    let mid = classified(&h, &root, "docs/a.md", "docs");
    let head = classified(&h, &mid, "README.md", "docs");
    // History an import truncated ends here: nothing shows what lies below.
    h.db.query("DELETE FROM commits WHERE id=?", &[json!(mid)])
        .unwrap();
    assert_eq!(gates(&h, &head)["auto_approved"], false);
    assert_eq!(land(&h, &head), "NOT_READY");
}

#[test]
fn a_merge_on_the_way_needs_a_human_even_if_classified() {
    let (h, root) = repo();
    let side = classified(&h, &root, "docs/side.md", "docs");
    let merge = |parent: &str| {
        let id = h
            .commit_with(
                AGENT,
                Some(parent),
                1,
                json!([file("README.md", "x\n")]),
                json!([]),
                json!({"merge_parent": side}),
            )
            .unwrap();
        classify(&h, &id, "README.md", "docs");
        id
    };
    let tip = merge(&root);
    assert_eq!(gates(&h, &tip)["auto_approved"], false, "the head is one");
    assert_eq!(land(&h, &tip), "NOT_READY");
    let below = classified(&h, &tip, "docs/after.md", "docs");
    assert_eq!(gates(&h, &below)["auto_approved"], false, "below the head");
    assert_eq!(land(&h, &below), "NOT_READY");
}

#[test]
fn a_branch_behind_its_base_is_judged_on_what_it_would_bring() {
    let (h, root) = repo();
    let logic = classified(&h, &root, "src/retry.rs", "logic");
    let smuggled = classified(&h, &logic, "docs/a.md", "docs");
    let stale = classified(&h, &root, "docs/b.md", "docs");
    let chained = classified(&h, &stale, "docs/c.md", "docs");
    let moved = classified(&h, &root, "README.md", "docs");
    assert_eq!(land(&h, &moved), "OK");

    assert_eq!(gates(&h, &smuggled)["auto_approved"], false);
    assert_eq!(land(&h, &smuggled), "NOT_READY");
    // Nothing but docs since the fork: past the gate, landing merges it on the server.
    assert_eq!(gates(&h, &chained)["auto_approved"], true);
    assert_eq!(land(&h, &chained), "MERGE_REQUIRED");
}

#[test]
fn a_landing_on_a_release_ref_counts_what_main_already_has() {
    let (h, root) = seeded();
    let policy = |approvals: u64| {
        h.ok(
            OWNER,
            json!({"op":"repo_set_policy","policy":{"required_checks":[],
            "approvals":approvals,"auto_approve":["docs"]}}),
        );
    };
    policy(0);
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"release/1","commit":root}),
    );
    policy(1);
    let logic = classified(&h, &root, "src/retry.rs", "logic");
    approve(&h, &logic);
    assert_eq!(land(&h, &logic), "OK");
    let docs = classified(&h, &logic, "docs/a.md", "docs");
    assert_eq!(land(&h, &docs), "OK", "main has the logic");
    let on_release = json!({"op":"repo_land","ref":"release/1","commit":docs});
    assert_eq!(
        code(h.run(OWNER, on_release)),
        "NOT_READY",
        "release does not"
    );

    // A change reads its head's gates against its base, as landing there does.
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch",
        "updates":[{"ref":"fix","commit":docs,"expected":null}]}),
    );
    let change = |base: &str| {
        let number = h.ok(
            AGENT,
            json!({"op":"repo_change_create","branch":"fix",
            "title":base,"base":base}),
        )["number"]
            .clone();
        h.ok(CI, json!({"op":"repo_change_show","number":number}))["head_commit"]["gates"]
            ["auto_approved"]
            .clone()
    };
    assert_eq!(change("main"), true);
    h.ok(OWNER, json!({"op":"repo_change_close","number":1}));
    assert_eq!(change("release/1"), false);
}

#[test]
fn the_walk_is_bounded_and_fails_closed_past_it() {
    let (h, root) = repo();
    let mut tip = root;
    for i in 0..WALK {
        tip = classified(&h, &tip, &format!("docs/{i}.md"), "docs");
    }
    assert_eq!(gates(&h, &tip)["auto_approved"], true, "at the bound");
    let past = classified(&h, &tip, "docs/past.md", "docs");
    assert_eq!(gates(&h, &past)["auto_approved"], false, "past the bound");
    assert_eq!(land(&h, &past), "NOT_READY");
    approve(&h, &past);
    assert_eq!(land(&h, &past), "OK", "a human approval still lands it");
}

/// A shard's record of a commit on `parent` (none: the published head) with its class.
fn shard(h: &Harness, parent: Option<&Value>, path: &str, class: &str) -> Value {
    let mut record = match parent {
        None => h.shard_commit(AGENT, path, "x\n", json!([])),
        Some(parent) => {
            let on = &parent["commit"];
            let begun = json!({"parent": {"id": on["id"], "tree": on["tree"], "generation": on["generation"]},
                "base_version": on["base_version"], "principal": AGENT});
            h.shard_commit_from(&begun, path, "x\n", json!([]))
        }
    };
    record["classes"] = json!({"overall": class,
        "files": json!([{"path": path, "class": class}]).to_string()});
    record
}

fn submit_chain(h: &Harness, records: &[&Value]) -> Value {
    let items = vec![json!({"credentials": credentials(OWNER), "records": records})];
    h.ok(
        MERGER,
        json!({"op":"repo_land_submitted","ref":"main","items":items}),
    )
}

#[test]
fn a_submitted_chain_is_judged_whole() {
    let (h, _) = repo();
    let logic = shard(&h, None, "src/retry.rs", "logic");
    let head = shard(&h, Some(&logic), "README.md", "docs");
    // Its tip alone reads as docs: the authority asks for the chain before judging it.
    assert_eq!(outcome(&h.submit(vec![(OWNER, &head)]), 0).0, "need_chain");
    let refused = submit_chain(&h, &[&logic, &head]);
    let (status, item) = outcome(&refused, 0);
    assert_eq!(
        (status.as_str(), &item["code"]),
        ("failed", &json!("NOT_READY"))
    );
    // Nothing landed; the chain is adopted, so a reviewer can approve it and it lands.
    let id = head["commit"]["id"].as_str().unwrap();
    let shown = h.ok(OWNER, json!({"op":"repo_commit","commit":id}));
    assert_eq!(shown["landings"], json!([]));
    approve(&h, id);
    let approved = h.submit(vec![(OWNER, &head)]);
    assert_eq!(outcome(&approved, 0).0, "queued", "{approved}");
}

#[test]
fn submitted_docs_land_alone_and_as_a_chain() {
    let (h, _) = repo();
    let lone = shard(&h, None, "README.md", "docs");
    assert_eq!(outcome(&h.submit(vec![(OWNER, &lone)]), 0).0, "landed");
    let first = shard(&h, None, "docs/a.md", "docs");
    let second = shard(&h, Some(&first), "docs/b.md", "docs");
    assert_eq!(
        outcome(&h.submit(vec![(OWNER, &second)]), 0).0,
        "need_chain"
    );
    let chain = submit_chain(&h, &[&first, &second]);
    assert_eq!(outcome(&chain, 0).0, "queued", "{chain}");
}

/// One commit pushed on `parent` touching `path`.
fn pushed(h: &Harness, parent: &str, path: &str, blob: &str) -> (String, Value) {
    let tree = h.ok(
        OWNER,
        json!({"op":"repo_commit","commit":parent,"brief":true}),
    )["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let (id, mut item) = super::pushed::pushed(parent, &tree, path);
    item["touches"] =
        json!([{"path":path,"op":"add","old_blob":null,"new_blob":blob,"mode":"blob"}]);
    let answer = super::pushed::record(h, AGENT, json!([item])).unwrap();
    (id, answer)
}

const BLOB: &str = "1111111111111111111111111111111111111111";

#[test]
fn a_push_is_classified_only_where_the_policy_auto_approves() {
    let (plain, root) = seeded();
    let (_, answer) = pushed(&plain, &root, "docs/a.md", BLOB);
    assert_eq!(answer["classify"], false);
    let (h, root) = repo();
    let (_, answer) = pushed(&h, &root, "docs/a.md", BLOB);
    assert_eq!(answer["classify"], true);
}

#[test]
fn pending_lists_pushed_commits_with_no_class_and_their_files() {
    let (h, root) = repo();
    let (first, _) = pushed(&h, &root, "docs/a.md", BLOB);
    let (second, _) = pushed(&h, &first, "docs/b.md", BLOB);
    let done = classified(&h, &root, "docs/c.md", "docs");
    let pending = json!({"op":"repo_classes_pending","commits":[first,second,done]});
    assert_eq!(code(h.run(OWNER, pending.clone())), "FORBIDDEN");
    assert_eq!(code(h.run(AGENT, pending.clone())), "FORBIDDEN");
    let answer = h.ok(CLASSIFIER, pending);
    let listed = answer["pending"].as_array().unwrap();
    assert_eq!(listed.len(), 2, "{answer}");
    assert_eq!(listed[0]["commit"], json!(first));
    assert_eq!(listed[1]["commit"], json!(second));
    assert_eq!(
        listed[0]["touches"],
        json!([{"path":"docs/a.md","op":"add","old_blob":null,"new_blob":BLOB,"mode":"blob"}])
    );

    // A commit unknown here (say, forgotten after a purge) is left out, not an error.
    let unknown = "2".repeat(40);
    let answer = h.ok(
        CLASSIFIER,
        json!({"op":"repo_classes_pending","commits":[unknown]}),
    );
    assert_eq!(answer["pending"], json!([]));

    let many: Vec<String> = (0..33).map(|_| "3".repeat(40)).collect();
    assert_eq!(
        code(h.run(
            CLASSIFIER,
            json!({"op":"repo_classes_pending","commits":many}),
        )),
        "INVALID_INPUT"
    );
}

#[test]
fn pending_stops_at_the_file_budget_a_commit_cannot_be_read_past() {
    let (h, root) = repo();
    let tree = h.ok(
        OWNER,
        json!({"op":"repo_commit","commit":root,"brief":true}),
    )["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let (id, mut item) = super::pushed::pushed(&root, &tree, "wide");
    let files: Vec<Value> = (0..300)
        .map(|n| json!({"path":format!("docs/{n}.md"),"op":"add","old_blob":null,"new_blob":BLOB,"mode":"blob"}))
        .collect();
    item["touches"] = json!(files);
    super::pushed::record(&h, AGENT, json!([item])).unwrap();
    let answer = h.ok(
        CLASSIFIER,
        json!({"op":"repo_classes_pending","commits":[id]}),
    );
    assert_eq!(
        answer["pending"][0]["touches"].as_array().unwrap().len(),
        201,
        "one past the budget, so the job sees it is over"
    );
}

#[test]
fn a_pushed_commit_classified_docs_auto_approves_and_logic_needs_a_human() {
    let (h, root) = repo();
    let (docs, _) = pushed(&h, &root, "docs/a.md", BLOB);
    assert_eq!(
        gates(&h, &docs)["auto_approved"],
        false,
        "not classified yet"
    );
    assert_eq!(land(&h, &docs), "NOT_READY");
    classify(&h, &docs, "docs/a.md", "docs");
    assert_eq!(gates(&h, &docs)["auto_approved"], true);

    let (logic, _) = pushed(&h, &docs, "src/a.rs", BLOB);
    classify(&h, &logic, "src/a.rs", "logic");
    assert_eq!(land(&h, &logic), "NOT_READY");
}
