//! Staged commits: accepted once the authority holds their objects, pushed afterwards by
//! the projector. Accepted objects stay readable by id until the store has them, refs wait
//! for them, and a failed or repeated projection never loses or duplicates anything.
use super::*;
use crate::platform_compute;
use crate::storage::SqlStore;

const PROJECTOR: &str = "platform:projection";

/// Plays the adapter's staged path: answer tree requests from cached copies, stage, record.
fn commit_staged(h: &Harness, parent: &str, version: u64, path: &str, text: &str) -> Value {
    let mut trees = serde_json::Map::new();
    loop {
        let prepared = h.ok(
            AGENT,
            json!({
                "op": "repo_prepare_commit", "parent": parent, "base_version": version,
                "changes": [file(path, text)], "trees": trees, "stage": true,
                "message": "staged", "author": {"name": "Agent", "email": "agent@example.com"},
            }),
        );
        if let Some(need) = prepared["need_trees"].as_array() {
            for id in need {
                let id = id.as_str().unwrap();
                let cached = h.cached.borrow().get(id).cloned();
                let entries = match cached {
                    Some(tree) => tree["entries"].clone(),
                    None => h.tree_json(id),
                };
                trees.insert(id.into(), entries);
            }
            continue;
        }
        for object in prepared["objects"].as_array().unwrap() {
            h.cached
                .borrow_mut()
                .insert(object["id"].as_str().unwrap().into(), object.clone());
        }
        assert_eq!(prepared["staged"], true);
        assert!(prepared.get("push_b64").is_none());
        let recorded = h.ok(
            AGENT,
            json!({"op": "repo_record_commit", "commit": prepared["commit"], "staged": true}),
        );
        assert_eq!(recorded["staged"], true);
        let mut prepared = prepared;
        prepared["dispatch_objects"] = recorded["dispatch_objects"].clone();
        return prepared;
    }
}

/// Plays the projector: push every pending commit to the harness store and report `outcome`.
fn project(h: &Harness, outcome: &str) -> Vec<String> {
    let pending = h.ok(PROJECTOR, json!({"op": "repo_objects_pending"}));
    let mut results = Vec::new();
    let mut commits = Vec::new();
    for entry in pending["commits"].as_array().unwrap() {
        let commit = entry["commit"].as_str().unwrap().to_owned();
        let push = platform_compute(
            json!({"op": "staged_push", "commit": commit, "objects": entry["objects"]}),
        )
        .unwrap();
        if outcome == "ok" {
            h.receive(
                &STANDARD.decode(push["push_b64"].as_str().unwrap()).unwrap(),
                &format!("refs/yoneda/c/{commit}"),
            );
        }
        results.push(json!({"commit": commit, "outcome": outcome, "detail": "store unavailable"}));
        commits.push(commit);
    }
    if !results.is_empty() {
        h.ok(
            PROJECTOR,
            json!({"op": "repo_objects_projected", "results": results}),
        );
    }
    commits
}

fn staged_read(h: &Harness, ids: &[&str]) -> Vec<Value> {
    h.ok(PROJECTOR, json!({"op": "repo_staged_objects", "ids": ids}))["objects"]
        .as_array()
        .unwrap()
        .clone()
}

fn pending(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op": "repo_status"}))["objects"].clone()
}

#[test]
fn staged_commits_are_readable_until_projected_then_live_in_the_store() {
    let (h, root) = seeded();
    let prepared = commit_staged(&h, &root, 1, "src/new.rs", "pub fn new() {}\n");
    let ids: Vec<&str> = prepared["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| o["id"].as_str().unwrap())
        .collect();
    // Accepted and durable in the authority, but not yet in the object store.
    assert_eq!(pending(&h)["pending"], 1);
    for id in &ids {
        assert!(!h.objects.borrow().contains_key(*id));
    }
    let read = staged_read(&h, &ids);
    assert_eq!(read.len(), ids.len());
    for object in &read {
        assert_eq!(&h.cached.borrow()[object["id"].as_str().unwrap()], object);
    }
    // A ref cannot be projected to objects the store lacks.
    assert_eq!(
        h.ok(PROJECTOR, json!({"op": "repo_projection_pending"}))["objects_pending"],
        1
    );
    // Work keeps going on top of a staged parent.
    let child = commit_staged(
        &h,
        prepared["commit"].as_str().unwrap(),
        1,
        "src/more.rs",
        "x\n",
    );
    assert_eq!(pending(&h)["pending"], 2);

    let pushed = project(&h, "ok");
    assert_eq!(pushed.len(), 2);
    for object in prepared["objects"]
        .as_array()
        .unwrap()
        .iter()
        .chain(child["objects"].as_array().unwrap())
    {
        assert!(
            h.objects
                .borrow()
                .contains_key(object["id"].as_str().unwrap())
        );
    }
    assert_eq!(pending(&h)["pending"], 0);
    assert!(staged_read(&h, &ids).is_empty());
    assert_eq!(
        h.ok(PROJECTOR, json!({"op": "repo_projection_pending"}))["objects_pending"],
        0
    );
}

#[test]
fn a_failed_push_after_accept_stays_pending_visible_and_readable() {
    let (h, root) = seeded();
    let prepared = commit_staged(&h, &root, 1, "a.txt", "a\n");
    let commit = prepared["commit"].as_str().unwrap();
    assert_eq!(project(&h, "failed"), vec![commit.to_owned()]);
    let status = pending(&h);
    assert_eq!(status["pending"], 1);
    assert_eq!(status["oldest"]["attempts"], 1);
    assert_eq!(status["oldest"]["detail"], "store unavailable");
    // The commit stays recorded and its objects readable while the store is down.
    assert_eq!(
        h.ok(OWNER, json!({"op": "repo_commit", "commit": commit}))["commit"],
        commit
    );
    assert_eq!(staged_read(&h, &[commit]).len(), 1);
    // A later projector (a retry, the next commit's job, or a restarted Worker) resumes.
    assert_eq!(project(&h, "ok"), vec![commit.to_owned()]);
    assert_eq!(pending(&h)["pending"], 0);
    assert!(h.objects.borrow().contains_key(commit));
}

#[test]
fn duplicate_projection_and_record_are_idempotent() {
    let (h, root) = seeded();
    let prepared = commit_staged(&h, &root, 1, "a.txt", "a\n");
    let commit = prepared["commit"].clone();
    let ok =
        json!({"op": "repo_objects_projected", "results": [{"commit": commit, "outcome": "ok"}]});
    project(&h, "ok");
    // A redelivered queue message reports the same commit again: nothing changes.
    assert_eq!(h.ok(PROJECTOR, ok.clone())["pending"], 0);
    assert_eq!(h.ok(PROJECTOR, ok)["projected"], 1);
    assert!(project(&h, "ok").is_empty());
    assert_eq!(
        h.ok(
            AGENT,
            json!({"op": "repo_record_commit", "commit": commit, "staged": true})
        )["already"],
        true
    );
}

#[test]
fn only_staged_objects_of_accepted_commits_are_served_and_unaccepted_ones_expire() {
    let (h, root) = seeded();
    let tree = h.ok(OWNER, json!({"op": "repo_commit", "commit": root}))["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    // Prepared and staged, never recorded: not readable, and gone after the TTL.
    let prepared = h.ok(AGENT, json!({
        "op": "repo_prepare_commit", "parent": root, "base_version": 1, "stage": true,
        "changes": [file("README.md", "# changed\n")], "message": "m", "trees": {tree.clone(): h.tree_json(&tree)},
        "author": {"name": "Agent", "email": "agent@example.com"},
    }));
    let commit = prepared["commit"].as_str().unwrap().to_owned();
    assert!(staged_read(&h, &[&commit]).is_empty());
    *h.now.borrow_mut() += 2 * 60 * 60 * 1000;
    commit_staged(&h, &root, 1, "b.txt", "b\n");
    let left =
        h.db.query(
            "SELECT COUNT(*) AS n FROM staged_objects WHERE commit_id=?",
            &[json!(commit)],
        )
        .unwrap();
    assert_eq!(left[0]["n"], 0);
}

#[test]
fn large_commits_are_pushed_and_outbox_ops_are_platform_only() {
    let (h, root) = seeded();
    let tree = h.ok(OWNER, json!({"op": "repo_commit", "commit": root}))["tree"]
        .as_str()
        .unwrap()
        .to_owned();
    let big = "x".repeat(super::super::staging::STAGE_LIMIT + 1);
    let prepared = h.ok(AGENT, json!({
        "op": "repo_prepare_commit", "parent": root, "base_version": 1, "stage": true,
        "changes": [file("big.txt", &big)], "message": "big", "trees": {tree.clone(): h.tree_json(&tree)},
        "author": {"name": "Agent", "email": "agent@example.com"},
    }));
    assert!(prepared.get("staged").is_none());
    assert!(prepared["push_b64"].is_string());
    assert_eq!(
        code(h.run(
            AGENT,
            json!({"op": "repo_record_commit", "commit": prepared["commit"], "staged": true})
        )),
        "NOT_FOUND"
    );
    for op in [
        json!({"op": "repo_objects_pending"}),
        json!({"op": "repo_objects_projected", "results": []}),
        json!({"op": "repo_staged_objects", "ids": [root]}),
    ] {
        assert_eq!(code(h.run(AGENT, op.clone())), "FORBIDDEN");
        assert_eq!(code(h.run(OWNER, op)), "FORBIDDEN");
    }
}

#[test]
fn vacuum_keeps_hidden_refs_of_commits_still_staged() {
    let (h, root) = seeded();
    let prepared = commit_staged(&h, &root, 1, "a.txt", "a\n");
    *h.now.borrow_mut() += 30 * 24 * 60 * 60 * 1000;
    let plan = h.ok(OWNER, json!({"op": "repo_vacuum_plan"}));
    assert!(
        !plan["expired"]
            .as_array()
            .unwrap()
            .contains(&prepared["commit"])
    );
    project(&h, "ok");
    let plan = h.ok(OWNER, json!({"op": "repo_vacuum_plan"}));
    assert!(
        plan["expired"]
            .as_array()
            .unwrap()
            .contains(&prepared["commit"])
    );
}

#[test]
fn a_burst_of_staged_commits_asks_for_one_projector_job() {
    let (h, root) = seeded();
    let first = commit_staged(&h, &root, 1, "a.txt", "a\n");
    assert_eq!(first["dispatch_objects"], true);
    let second = commit_staged(&h, &root, 1, "b.txt", "b\n");
    assert_eq!(second["dispatch_objects"], false);
    // The job drains and finds the outbox empty: the next commit asks again.
    project(&h, "ok");
    assert!(project(&h, "ok").is_empty());
    assert_eq!(
        commit_staged(&h, &root, 1, "c.txt", "c\n")["dispatch_objects"],
        true
    );
    // A request that never produced a job (a lost message) is resent once it looks stale.
    *h.now.borrow_mut() += 60_000;
    assert_eq!(
        commit_staged(&h, &root, 1, "d.txt", "d\n")["dispatch_objects"],
        true
    );
}

#[test]
fn prepare_resolves_a_branch_head_from_remembered_trees_and_names_the_store() {
    let (h, root) = seeded();
    let by_ref = |path: &str| {
        h.run(AGENT, json!({
            "op": "repo_prepare_commit", "ref": "main", "changes": [file(path, "a\n")],
            "trees": {}, "message": "m", "author": {"name": "Agent", "email": "agent@example.com"},
        }))
    };
    // The authority built the head's trees itself, so one round builds the commit.
    let prepared = by_ref("src/a.rs").unwrap();
    assert_eq!(prepared["parents"], json!([root]));
    assert_eq!(prepared["base_version"], 1);
    assert_eq!(prepared["object_store"], "artifacts:test/demo");
    // Without remembered trees it asks, pinning the head it resolved for the next round.
    h.db.query("DELETE FROM tree_cache", &[]).unwrap();
    let asked = by_ref("src/b.rs").unwrap();
    assert_eq!(asked["parent"], root);
    assert_eq!(asked["base_version"], 1);
    assert_eq!(asked["need_trees"].as_array().unwrap().len(), 1);
    assert_eq!(
        code(h.run(AGENT, json!({
            "op": "repo_prepare_commit", "ref": "missing", "changes": [file("a.txt", "a\n")],
            "trees": {}, "message": "m", "author": {"name": "Agent", "email": "agent@example.com"},
        }))),
        "NOT_FOUND"
    );
}
