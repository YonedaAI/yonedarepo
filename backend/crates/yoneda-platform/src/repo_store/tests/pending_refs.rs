//! Between a landing and its projection only the refs with landed changesets wait: every
//! other branch and tag stays readable (a partial listing, logs, snapshots, path
//! history), and a ref that waits is named as pending, never shown at a value that skips
//! its changesets.
use super::batches::open;
use super::*;

#[test]
fn only_refs_with_unprojected_changesets_wait_for_the_projector() {
    let (h, root) = open();
    let work = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("w.txt", "work\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"work","commit":root,"expected":null}),
    );
    h.ok(AGENT, json!({"op":"repo_land","ref":"work","commit":work}));
    h.ok(
        OWNER,
        json!({"op":"repo_tag_create","name":"v1","commit":root}),
    );
    // A changeset on main, not projected yet.
    let landed = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    assert_eq!(
        h.submit(vec![(OWNER, &landed)])["items"][0]["status"],
        "landed"
    );

    // A plain listing waits for the projector (the adapter retries); a partial one
    // answers every other ref now.
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_refs"}))),
        "PROJECTION_PENDING"
    );
    let listed = h.ok(OWNER, json!({"op":"repo_refs","partial":true}));
    assert_eq!(listed["refs"]["refs/heads/work"], json!(work), "{listed}");
    assert_eq!(listed["refs"]["refs/tags/v1"], json!(root), "{listed}");
    // Main is pending, not shown at its last projected commit.
    assert!(listed["refs"].get("refs/heads/main").is_none(), "{listed}");
    assert_eq!(listed["pending"], json!(["refs/heads/main"]), "{listed}");
    let read = |c: Value| h.run(OWNER, c);
    assert_eq!(
        read(json!({"op":"repo_log","ref":"work","limit":5})).unwrap()["commits"][0]["commit"],
        json!(work)
    );
    assert_eq!(
        read(json!({"op":"repo_snapshot","ref":"work"})).unwrap()["commit"],
        json!(work)
    );
    assert!(read(json!({"op":"repo_path_history","ref":"work","path":"w.txt"})).is_ok());
    for waits in [
        json!({"op":"repo_log","ref":"main","limit":5}),
        json!({"op":"repo_snapshot","ref":"main"}),
        json!({"op":"repo_path_history","ref":"main","path":"a.txt"}),
        // A rebase onto main reads main.
        json!({"op":"repo_rebase_plan","ref":"work","onto":"main"}),
    ] {
        assert_eq!(code(read(waits.clone())), "PROJECTION_PENDING", "{waits}");
    }

    h.project_all();
    let listed = h.ok(OWNER, json!({"op":"repo_refs","partial":true}));
    assert!(listed["refs"]["refs/heads/main"].is_string(), "{listed}");
    assert_eq!(listed["pending"], json!([]), "{listed}");
    assert!(h.run(OWNER, json!({"op":"repo_refs"})).is_ok());
}
