//! Git history shapes of landing, as a pusher's `git pull --ff-only` needs them: main's
//! projected commit is the pushed commit itself for a fast-forward, otherwise a merge
//! whose parents include every pushed commit; and the first landing of an empty
//! repository creates main at the pushed commit.
use super::batches::{credentials, open, outcome};
use super::*;

const MERGER: &str = "platform:merge";
const PROJECTOR: &str = "platform:projection";

impl Harness {
    fn main_head(&self) -> String {
        self.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn parents_of(&self, commit: &str) -> Vec<String> {
        self.ok(OWNER, json!({"op":"repo_commit","commit":commit}))["parents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_owned())
            .collect()
    }
    /// Begins a commit through the authority (`ref`, or an explicit parent and base).
    fn begin(&self, at: Value) -> Value {
        let mut command = json!({"op":"repo_begin_commit","paths":["x"]});
        for (key, value) in at.as_object().into_iter().flatten() {
            command[key] = value.clone();
        }
        self.ok(OWNER, command)
    }
    fn submit_chain(&self, records: &[&Value]) -> Value {
        let items = vec![json!({"credentials": credentials(OWNER), "records": records})];
        self.ok(
            MERGER,
            json!({"op":"repo_land_submitted","ref":"main","items":items}),
        )
    }
}

fn id(record: &Value) -> String {
    record["commit"]["id"].as_str().unwrap().to_owned()
}

#[test]
fn a_lone_changeset_on_main_lands_as_the_pushed_commit() {
    let (h, root) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    assert_eq!(outcome(&h.submit(vec![(OWNER, &a)]), 0).0, "landed");
    h.project_all();
    // No wrapper commit: main is exactly the pushed commit, child of the old main.
    assert_eq!(h.main_head(), id(&a));
    assert_eq!(h.parents_of(&id(&a)), std::slice::from_ref(&root));
    // The next push on top of it fast-forwards again.
    let b = h.shard_commit(AGENT, "b.txt", "b\n", json!([]));
    h.submit(vec![(OWNER, &b)]);
    h.project_all();
    assert_eq!(h.main_head(), id(&b));
    assert_eq!(h.parents_of(&id(&b)), [id(&a)]);
    // Each version reads as its own commit.
    for (at, commit) in [(1, &root), (2, &id(&a)), (3, &id(&b))] {
        assert_eq!(
            h.ok(OWNER, json!({"op":"repo_refs","at":at}))["refs"]["refs/heads/main"],
            commit.as_str()
        );
    }
}

#[test]
fn concurrent_changesets_land_as_a_merge_of_every_pushed_commit() {
    let (h, root) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    let b = h.shard_commit(AGENT, "d/b.txt", "b\n", json!([]));
    let batch = h.submit(vec![(OWNER, &a), (OWNER, &b)]);
    assert_eq!(
        (outcome(&batch, 0).0, outcome(&batch, 1).0),
        ("landed".into(), "landed".into())
    );
    h.project_all();
    let head = h.main_head();
    assert_eq!(h.parents_of(&head), [root, id(&a), id(&b)]);
    assert_eq!(h.file_at(&head, "a.txt").as_deref(), Some("a\n"));
    assert_eq!(h.file_at(&head, "d/b.txt").as_deref(), Some("b\n"));
    let shown = h.ok(OWNER, json!({"op":"repo_commit","commit":head}));
    assert_eq!(shown["principal"], "platform:merge");
    // Both landed commits are recorded now (adopted by the projection).
    for record in [&a, &b] {
        h.ok(OWNER, json!({"op":"repo_commit","commit":id(record)}));
    }
}

#[test]
fn a_changeset_on_an_older_main_lands_as_a_merge_with_the_current_main() {
    let (h, root) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    let b = h.shard_commit(AGENT, "b.txt", "b\n", json!([]));
    h.submit(vec![(OWNER, &a)]);
    h.submit(vec![(OWNER, &b)]);
    h.project_all();
    let head = h.main_head();
    assert_eq!(h.parents_of(&id(&a)), [root]);
    assert_eq!(h.parents_of(&head), [id(&a), id(&b)]);
    assert_eq!(h.file_at(&head, "b.txt").as_deref(), Some("b\n"));
}

#[test]
fn queued_changesets_keep_the_same_shapes() {
    let (h, root) = seeded();
    let landable = |path: &str| {
        let id = h
            .commit(AGENT, Some(&root), 1, json!([file(path, "x\n")]), json!([]))
            .unwrap();
        h.approve_and_check(&id);
        h.ok(
            OWNER,
            json!({"op":"repo_land_enqueue","ref":"main","commit":id}),
        );
        id
    };
    let (x, y) = (landable("x.txt"), landable("y.txt"));
    h.ok(MERGER, json!({"op":"repo_land_changesets","ref":"main"}));
    h.project_all();
    // `x` fast-forwarded on the spot; `y`, built on the old main, merges with it.
    let head = h.main_head();
    assert_eq!(h.parents_of(&head), [x, y]);
}

#[test]
fn a_batch_larger_than_a_merge_projects_as_consecutive_merges() {
    let (h, root) = open();
    let records: Vec<Value> = (0..130)
        .map(|i| h.shard_commit(AGENT, &format!("w/{i}.txt"), "w\n", json!([])))
        .collect();
    let batch = h.submit(records.iter().map(|r| (OWNER, r)).collect());
    assert!(
        batch["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["status"] == "landed")
    );
    h.project_all();
    let head = h.main_head();
    let parents = h.parents_of(&head);
    assert_eq!(parents[1..], [id(&records[128]), id(&records[129])]);
    let first = h.parents_of(&parents[0]);
    assert_eq!(first.len(), 129);
    assert_eq!(first[0], root);
    assert_eq!(
        first[1..],
        records[..128].iter().map(id).collect::<Vec<_>>()
    );
}

#[test]
fn a_landed_commit_whose_record_is_gone_still_projects() {
    let (h, root) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    let b = h.shard_commit(AGENT, "b.txt", "b\n", json!([]));
    h.submit(vec![(OWNER, &a), (OWNER, &b)]);
    // A shard forgot `b` before the projector asked: main names what it can adopt.
    h.shard.borrow_mut().remove(&id(&b));
    h.project_all();
    let head = h.main_head();
    assert_eq!(h.parents_of(&head), [root, id(&a)]);
    assert_eq!(h.file_at(&head, "b.txt").as_deref(), Some("b\n"));
}

#[test]
fn a_projection_planned_before_an_adoption_plans_again() {
    let (h, _) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    let b = h.shard_commit(AGENT, "b.txt", "b\n", json!([]));
    h.submit(vec![(OWNER, &a), (OWNER, &b)]);
    let plan = h.ok(PROJECTOR, json!({"op":"repo_changeset_plan"}));
    // Built without `b` (no record found), then a reader adopts `b` before the record.
    let built = h.project_compute(&plan);
    h.ok(
        "platform:commits",
        json!({"op":"repo_adopt_commit","record":b}),
    );
    let stale = h.run(
        PROJECTOR,
        json!({"op":"repo_changeset_record","ref":"main","from":plan["head"]["id"],
            "items":built["projected"],"records":[a]}),
    );
    assert_eq!(code(stale), "STALE_HEAD");
    h.project_all();
    assert_eq!(h.parents_of(&h.main_head())[1..], [id(&a), id(&b)]);
}

/// An empty repository whose policy lets anything land.
fn empty() -> Harness {
    let h = Harness::new();
    h.ok(
        OWNER,
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    );
    h
}

#[test]
fn the_first_landing_of_an_empty_repository_creates_main_at_the_pushed_commit() {
    let h = empty();
    // A commit on main in an empty repository is a root commit.
    let begun = h.begin(json!({"ref":"main"}));
    assert_eq!(begun["parent"], Value::Null);
    let root = h.shard_commit_from(&begun, "a.txt", "a\n", json!([]));
    let child = {
        let on = json!({"parent": id(&root), "base_version": 0});
        let begun = h.begin(on);
        assert_eq!(begun["parent_elsewhere"], true);
        let parent = json!({"id": root["commit"]["id"], "tree": root["commit"]["tree"],
            "generation": root["commit"]["generation"]});
        let begun = json!({"parent": parent, "base_version": 0, "principal": begun["principal"]});
        h.shard_commit_from(&begun, "b.txt", "b\n", json!([]))
    };
    // Only the tip's record: the lander is asked for the chain, then main is the tip.
    assert_eq!(outcome(&h.submit(vec![(OWNER, &child)]), 0).0, "need_chain");
    let landed = h.submit_chain(&[&root, &child]);
    assert_eq!(
        outcome(&landed, 0),
        ("landed".into(), landed["items"][0].clone())
    );
    assert_eq!(h.main_head(), id(&child));
    assert_eq!(h.parents_of(&id(&child)), [id(&root)]);
    assert_eq!(h.parents_of(&id(&root)), Vec::<String>::new());
    // Main exists now: a commit on a missing branch is not a root any more.
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_begin_commit","ref":"other","paths":["x"]})
        )),
        "NOT_FOUND"
    );
}

#[test]
fn a_server_side_commit_on_an_empty_main_lands_as_the_first_commit() {
    let h = empty();
    let id = h
        .commit_with(
            OWNER,
            None,
            0,
            json!([file("a.txt", "a\n")]),
            json!([]),
            json!({"parent": null, "ref": "main"}),
        )
        .unwrap();
    let landed = h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    assert_eq!(landed["commit"], id.as_str());
    assert_eq!(h.main_head(), id);
}
