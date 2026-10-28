//! Account-level access: personal access tokens (`_pat`, verified by the adapter) map onto
//! repository scopes, deleted repositories are tombstones, and batched ref updates apply
//! all together or not at all.
use super::*;
use crate::storage::SqlStore;

fn as_pat(h: &Harness, workspace: &str, scopes: Value, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    c["_pat"] = json!({"workspace": workspace, "principal": "user:owner", "id": "pat_0123456789abcdef", "scopes": scopes, "repos": null});
    execute_repo_store(&h.db, c)
}
fn pat(h: &Harness, scopes: Value, c: Value) -> yoneda_core::Result<Value> {
    as_pat(h, "ws-1", scopes, c)
}

#[test]
fn personal_tokens_hold_only_their_repository_scopes() {
    let (h, root) = seeded();
    let read = json!(["repo:read"]);
    assert_eq!(
        code(pat(&h, read.clone(), json!({"op":"repo_status"}))),
        "OK"
    );
    assert_eq!(
        code(pat(
            &h,
            read.clone(),
            json!({"op":"repo_branch_set","ref":"x","commit":root,"expected":null})
        )),
        "FORBIDDEN"
    );
    // A token can read the whole repository through a clone; break-glass stays human-only.
    assert_eq!(
        code(pat(&h, read.clone(), json!({"op":"repo_clone_access"}))),
        "OK"
    );
    assert_eq!(
        code(pat(
            &h,
            json!(["repo:write"]),
            json!({"op":"repo_clone_access"})
        )),
        "FORBIDDEN"
    );
    let write = json!(["repo:read", "repo:write"]);
    let moved = pat(
        &h,
        write.clone(),
        json!({"op":"repo_branch_set","ref":"x","commit":root,"expected":null}),
    )
    .unwrap();
    assert_eq!(moved["ref"], "refs/heads/x");
    let log = h.ok(OWNER, json!({"op":"repo_txlog","after":1,"limit":10}));
    assert_eq!(log["entries"][0]["actor"], "user:owner");
    for op in [
        json!({"op":"repo_land","ref":"main","commit":root}),
        json!({"op":"repo_review","commit":root,"decision":"approve"}),
        json!({"op":"repo_tokens"}),
        json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}}),
    ] {
        assert_eq!(
            code(pat(&h, write.clone(), op.clone())),
            "FORBIDDEN",
            "{op}"
        );
    }
    // The token is its account: it reviews others' commits, never the account's own.
    let review = |commit: &str| {
        pat(
            &h,
            json!(["repo:review"]),
            json!({"op":"repo_review","commit":commit,"decision":"approve"}),
        )
    };
    assert_eq!(code(review(&root)), "FORBIDDEN");
    let agents = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn a() { 3 }\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(code(review(&agents)), "OK");
    // repo:admin is the owner: tokens and policy, but never break-glass or another workspace.
    let admin = json!(["repo:admin"]);
    assert_eq!(
        code(pat(&h, admin.clone(), json!({"op":"repo_tokens"}))),
        "OK"
    );
    assert_eq!(
        code(pat(
            &h,
            admin.clone(),
            json!({"op":"repo_set_policy","policy":{"required_checks":[],"approvals":0}})
        )),
        "OK"
    );
    assert_eq!(
        code(pat(
            &h,
            admin.clone(),
            json!({"op":"repo_break_glass","action":"pause","reason":"x"})
        )),
        "FORBIDDEN"
    );
    assert_eq!(
        code(as_pat(
            &h,
            "ws-2",
            admin.clone(),
            json!({"op":"repo_status"})
        )),
        "NOT_FOUND"
    );
    assert_eq!(
        code(pat(&h, json!(["root"]), json!({"op":"repo_status"}))),
        "FORBIDDEN"
    );
}

#[test]
fn deleted_repositories_are_tombstones() {
    let (h, _root) = seeded();
    let delete =
        |who: &str, confirm: &str| h.run(who, json!({"op":"repo_delete","confirm":confirm}));
    assert_eq!(code(delete(AGENT, "demo")), "FORBIDDEN");
    assert_eq!(
        code(pat(
            &h,
            json!(["repo:read", "repo:write"]),
            json!({"op":"repo_delete","confirm":"demo"})
        )),
        "FORBIDDEN"
    );
    assert_eq!(code(delete(OWNER, "other")), "INVALID_INPUT");
    let deleted = pat(
        &h,
        json!(["repo:admin"]),
        json!({"op":"repo_delete","confirm":"demo"}),
    )
    .unwrap();
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["object_store"], "artifacts:test/demo");
    for who in [OWNER, AGENT, CI, SYSTEM] {
        assert_eq!(
            code(h.run(who, json!({"op":"repo_status"}))),
            "GONE",
            "{who}"
        );
    }
    assert_eq!(
        code(h.run(
            "platform:projection",
            json!({"op":"repo_head","ref":"main"})
        )),
        "GONE"
    );
    // Repository tokens are revoked with it.
    let live =
        h.db.query("SELECT name FROM tokens WHERE revoked_at IS NULL", &[])
            .unwrap();
    assert!(live.is_empty(), "{live:?}");
    // Retrying the delete is idempotent (the adapter re-runs its cleanup).
    assert_eq!(delete(OWNER, "demo").unwrap()["already"], true);
    assert_eq!(code(delete(OWNER, "other")), "INVALID_INPUT");
    // Only the platform purger reads what is left to purge.
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_purge_target"}))),
        "GONE"
    );
    let mut purge = json!({"op":"repo_purge_target","_system":"purge","now":1});
    let target = execute_repo_store(&h.db, purge.take()).unwrap();
    assert_eq!(target["object_store"], "artifacts:test/demo");
}

#[test]
fn purge_targets_only_deleted_repositories() {
    let (h, _root) = seeded();
    let mut purge = json!({"op":"repo_purge_target","_system":"purge","now":1});
    assert_eq!(code(execute_repo_store(&h.db, purge.take())), "NOT_FOUND");
}

#[test]
fn batched_ref_updates_apply_all_or_none() {
    let (h, root) = seeded();
    let child = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn a() { 2 }\n")]),
            json!([]),
        )
        .unwrap();
    let batch =
        |who: &str, updates: Value| h.run(who, json!({"op":"repo_branch_batch","updates":updates}));
    assert_eq!(
        code(batch(
            CI,
            json!([{"ref":"a","commit":root,"expected":null}])
        )),
        "FORBIDDEN"
    );
    assert_eq!(code(batch(AGENT, json!([]))), "INVALID_INPUT");
    assert_eq!(
        code(batch(
            AGENT,
            json!([{"ref":"a","commit":root,"expected":null},{"ref":"refs/heads/a","commit":child,"expected":null}])
        )),
        "INVALID_INPUT"
    );
    assert_eq!(
        code(batch(
            AGENT,
            json!([{"ref":"a","commit":root,"expected":null},{"ref":"main","commit":child,"expected":root}])
        )),
        "FORBIDDEN"
    );
    let applied = batch(AGENT, json!([{"ref":"a","commit":root,"expected":null},{"ref":"refs/heads/b","commit":child,"expected":null}])).unwrap();
    assert_eq!(applied["version"], 3);
    assert_eq!(applied["refs"][0]["ref"], "refs/heads/a");
    assert_eq!(applied["refs"][1]["commit"], child);
    // One stale expectation: nothing moves and the stale refs are named.
    let refused = batch(
        AGENT,
        json!([
            {"ref":"a","commit":child,"expected":root},
            {"ref":"b","commit":root,"expected":root},
            {"ref":"c","commit":root,"expected":child},
        ]),
    )
    .unwrap();
    assert_eq!(refused["stale"], json!(["refs/heads/b", "refs/heads/c"]));
    let refs = h.ok(OWNER, json!({"op":"repo_refs"}));
    assert_eq!(refs["refs"]["refs/heads/a"], root);
    assert_eq!(refs["refs"]["refs/heads/b"], child);
    assert!(refs["refs"].get("refs/heads/c").is_none());
    assert_eq!(h.ok(OWNER, json!({"op":"repo_status"}))["version"], 3);
    // A ref already at its target is not stale.
    let again = batch(AGENT, json!([{"ref":"a","commit":root,"expected":null},{"ref":"c","commit":child,"expected":null}])).unwrap();
    assert_eq!(again["version"], 4);
    // Unrecorded commits fail the whole batch.
    assert_eq!(
        code(batch(
            AGENT,
            json!([{"ref":"d","commit":"f".repeat(40),"expected":null}])
        )),
        "NOT_FOUND"
    );
}
