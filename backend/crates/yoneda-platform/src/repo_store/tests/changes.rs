//! Change requests: one open change per existing working branch, its head following the
//! branch, approvals on the head commit, anchored comments that resolve per anchor, close
//! and reopen by the author, the owner or a lander, and landing that marks the change landed
//! in the landing's own transaction (direct, platform-merge and queued paths). Change
//! events reach `change` hooks; text stays out of path-restricted ones. The tables arrive by
//! an additive migration that a second run leaves as it is.
use super::*;
use crate::storage::SqlStore;

const MERGER: &str = "platform:merge";
const HOOKS: &str = "platform:hooks";

fn token(h: &Harness, name: &str, scopes: Value, paths: Value) {
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":name,"scopes":scopes,"paths":paths,
        "_secret":format!("{name}-secret-0123456789abcdef0123456789")}),
    );
}

/// A commit on `parent` touching `path`, with `branch` set to it (created or moved).
fn push(h: &Harness, branch: &str, parent: &str, path: &str) -> String {
    let id = h
        .commit(
            AGENT,
            Some(parent),
            1,
            json!([file(path, "x\n")]),
            json!([]),
        )
        .unwrap();
    let current =
        h.ok(AGENT, json!({"op":"repo_refs"}))["refs"][format!("refs/heads/{branch}")].clone();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":branch,"commit":id,"expected":current}]}),
    );
    id
}

fn open(h: &Harness, who: &str, branch: &str) -> yoneda_core::Result<Value> {
    h.run(
        who,
        json!({"op":"repo_change_create","branch":branch,"title":"Retry with backoff","body":"Fixes flaky fetches."}),
    )
}

#[test]
fn a_change_follows_its_branch_and_lands_with_its_head() {
    let (h, root) = seeded();
    token(&h, "docs", json!(["read", "write"]), json!(["docs/"]));
    token(&h, "other", json!(["read", "write"]), Value::Null);
    let first = push(&h, "fix", &root, "src/retry.rs");
    // A branch moved with no open change answers null (a push then suggests one).
    let other = h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"other","commit":first,"expected":null}),
    );
    assert_eq!(other["change"], Value::Null);

    // Only an existing working branch, by a whole-repository writer, once while open.
    assert_eq!(code(open(&h, AGENT, "nope")), "NOT_FOUND");
    assert_eq!(code(open(&h, AGENT, "main")), "INVALID_INPUT");
    assert_eq!(code(open(&h, CI, "fix")), "FORBIDDEN");
    assert_eq!(code(open(&h, "token:docs", "fix")), "FORBIDDEN");
    let untitled = json!({"op":"repo_change_create","branch":"fix","title":"  "});
    assert_eq!(code(h.run(AGENT, untitled)), "INVALID_INPUT");
    let change = open(&h, AGENT, "refs/heads/fix").unwrap();
    assert_eq!(
        (
            &change["number"],
            &change["branch"],
            &change["status"],
            &change["author"]
        ),
        (&json!(1), &json!("fix"), &json!("open"), &json!(AGENT))
    );
    assert_eq!(
        (&change["head"], &change["comment_count"]),
        (&json!(first), &json!(0))
    );
    assert_eq!(code(open(&h, OWNER, "fix")), "ALREADY_EXISTS");

    // A push moves the head; the push answer names the branch's open change.
    let second = h
        .commit(
            AGENT,
            Some(&first),
            1,
            json!([file("src/retry.rs", "y\n")]),
            json!([]),
        )
        .unwrap();
    let pushed = h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":second,"expected":first}]}),
    );
    assert_eq!(pushed["refs"][0]["change"], 1);
    let shown = h.ok(CI, json!({"op":"repo_change_show","number":1}));
    assert_eq!(shown["head"], json!(second));
    assert_eq!(shown["head_commit"]["commit"], json!(second));
    assert_eq!(shown["head_commit"]["gates"]["ready"], false);
    let actions: Vec<&str> = shown["timeline"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["action"].as_str().unwrap())
        .collect();
    assert_eq!(actions, ["moved", "created"]);
    assert_eq!(shown["timeline"][0]["after"], json!(second));
    assert_eq!(
        code(h.run("token:docs", json!({"op":"repo_change_show","number":1}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_change_show","number":9}))),
        "NOT_FOUND"
    );

    // Landing an older commit of the branch leaves the change open.
    h.approve_and_check(&first);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}));
    assert_eq!(
        h.ok(CI, json!({"op":"repo_change_show","number":1}))["status"],
        "open"
    );
    // Approving the head (git_review) and landing it on main lands the change at that version.
    h.approve_and_check(&second);
    let landed = h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":second}),
    );
    let change = h.ok(CI, json!({"op":"repo_change_show","number":1}));
    assert_eq!(
        (
            &change["status"],
            &change["landed_version"],
            &change["landed_commit"],
            &change["head"]
        ),
        (
            &json!("landed"),
            &landed["version"],
            &json!(second),
            &json!(second)
        )
    );
    // A landed change neither closes nor reopens, and the branch takes a new one.
    let close = json!({"op":"repo_change_close","number":1});
    assert_eq!(code(h.run(AGENT, close)), "CONFLICT");
    assert_eq!(open(&h, AGENT, "fix").unwrap()["number"], 2);
    let listed = |status: &str| -> Vec<Value> {
        h.ok(CI, json!({"op":"repo_changes","status":status}))["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["number"].clone())
            .collect()
    };
    assert_eq!(listed("open"), [json!(2)]);
    assert_eq!(listed("landed"), [json!(1)]);
    assert_eq!(listed("all"), [json!(2), json!(1)]);
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_changes","status":"merged"}))),
        "INVALID_INPUT"
    );

    // Close and reopen: the author or the owner, never another writer.
    let close = json!({"op":"repo_change_close","number":2});
    assert_eq!(code(h.run("token:other", close.clone())), "FORBIDDEN");
    assert_eq!(h.ok(AGENT, close.clone())["status"], "closed");
    assert_eq!(h.ok(AGENT, close)["status"], "closed");
    let third = open(&h, OWNER, "fix").unwrap();
    let reopen = json!({"op":"repo_change_reopen","number":2});
    assert_eq!(code(h.run(OWNER, reopen.clone())), "ALREADY_EXISTS");
    h.ok(
        OWNER,
        json!({"op":"repo_change_close","number":third["number"]}),
    );
    assert_eq!(h.ok(OWNER, reopen)["status"], "open");
    // Migrating again changes nothing.
    crate::repo_store::migrate_repo_store(&h.db).unwrap();
    assert_eq!(listed("all").len(), 3);
}

#[test]
fn comments_anchor_to_diff_lines_and_resolve_per_anchor() {
    let (h, root) = seeded();
    let head = push(&h, "fix", &root, "src/retry.rs");
    open(&h, AGENT, "fix").unwrap();
    let say = |who: &str, extra: Value| {
        let mut c = json!({"op":"repo_change_comment","number":1});
        for (k, v) in extra.as_object().unwrap() {
            c[k] = v.clone();
        }
        h.run(who, c)
    };
    let general = say(OWNER, json!({"body":"Looks right."})).unwrap();
    assert_eq!(general["comment"]["commit"], json!(head));
    assert_eq!(general["comment"]["path"], Value::Null);
    let line = json!({"body":"Off by one?","path":"src/retry.rs","line":1,"side":"new"});
    let anchored = say(OWNER, line.clone()).unwrap()["comment"].clone();
    assert_eq!(
        (&anchored["line"], &anchored["side"]),
        (&json!(1), &json!("new"))
    );
    say(
        AGENT,
        json!({"body":"Same here.","path":"src/retry.rs","line":1,"side":"new"}),
    )
    .unwrap();
    // Anchors are whole, valid and on recorded commits; credentials never enter a comment.
    for bad in [
        json!({"body":"x","path":"src/retry.rs"}),
        json!({"body":"x","path":"a.rs","line":0,"side":"new"}),
        json!({"body":"x","path":"a.rs","line":1,"side":"left"}),
        json!({"body":"x".repeat(8001)}),
        json!({}),
        json!({"resolve":true}),
    ] {
        assert_eq!(code(say(OWNER, bad.clone())), "INVALID_INPUT", "{bad}");
    }
    let escape = json!({"body":"x","path":"../etc","line":1,"side":"new"});
    assert_eq!(code(say(OWNER, escape)), "UNSAFE_PATH");
    assert_eq!(
        code(say(OWNER, json!({"body":"x","commit":"e".repeat(40)}))),
        "NOT_FOUND"
    );
    let fake = ["sk-ant-", "api03-"].concat() + &"Ab1".repeat(31);
    assert_eq!(
        code(say(OWNER, json!({ "body": format!("key {fake}") }))),
        "SECRET_DETECTED"
    );
    // A check-only token cannot comment.
    assert_eq!(code(say(CI, json!({"body":"x"}))), "FORBIDDEN");

    // Resolving the anchor marks its comments (and a closing reply) resolved.
    let done = say(
        AGENT,
        json!({"body":"Fixed.","path":"src/retry.rs","line":1,"side":"new","resolve":true}),
    )
    .unwrap();
    assert_eq!(done["resolved"], 3);
    assert!(done["comment"]["resolved_at"].is_i64());
    let shown = h.ok(OWNER, json!({"op":"repo_change_show","number":1}));
    let comments = shown["comments"].as_array().unwrap();
    assert_eq!(comments.len(), 4);
    assert_eq!(shown["comment_count"], 4);
    assert!(comments[0]["resolved_at"].is_null());
    assert!(comments[1..].iter().all(|c| c["resolved_at"].is_i64()));
    let again = say(
        OWNER,
        json!({"path":"src/retry.rs","line":1,"side":"new","resolve":true}),
    )
    .unwrap();
    assert_eq!(
        (again["comment"].clone(), again["resolved"].clone()),
        (Value::Null, json!(0))
    );
}

#[test]
fn merged_and_queued_landings_land_their_changes() {
    let (h, root) = seeded();
    let docs = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/a.md", "a\n")]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&docs);
    let src = push(&h, "src", &root, "src/b.rs");
    let more = push(&h, "more", &root, "more.txt");
    let other = push(&h, "other", &root, "other.txt");
    for branch in ["src", "more", "other"] {
        open(&h, AGENT, branch).unwrap();
    }
    for id in [&src, &more, &other] {
        h.approve_and_check(id);
    }
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":docs}));
    // A platform merge lands src on the moved main: its change lands with the merge.
    let blob = |t: &str| yoneda_core::git_object::hash_object(ObjectKind::Blob, t.as_bytes());
    let version = || {
        h.ok(OWNER, json!({"op":"repo_refs"}))["version"]
            .as_u64()
            .unwrap()
    };
    let merged = h
        .commit_with(
            MERGER,
            Some(&docs),
            version(),
            json!([{"path":"src/b.rs","blob":blob("x\n"),"type":"blob"}]),
            json!([]),
            json!({"merge_parent": src}),
        )
        .unwrap();
    let landed = h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":src,"merge":merged}),
    );
    let status = |n: i64| h.ok(OWNER, json!({"op":"repo_change_show","number":n}));
    assert_eq!(status(1)["status"], "landed");
    assert_eq!(status(1)["landed_version"], landed["version"]);
    assert_eq!(status(1)["landed_commit"], json!(src));
    // Queued landings: the batch's merge lands both heads and both changes.
    let tickets: Vec<Value> = [&more, &other]
        .iter()
        .map(|c| {
            h.ok(
                OWNER,
                json!({"op":"repo_land_enqueue","ref":"main","commit":c}),
            )["ticket"]
                .clone()
        })
        .collect();
    let claim = h.ok(MERGER, json!({"op":"repo_land_claim","ref":"main"}));
    let batch = h
        .commit_with(MERGER, Some(&merged), version(),
            json!([{"path":"more.txt","blob":blob("x\n"),"type":"blob"},{"path":"other.txt","blob":blob("x\n"),"type":"blob"}]),
            json!([]), json!({"merge_parents": [more, other]}))
        .unwrap();
    h.ok(MERGER, json!({"op":"repo_land_batch","ref":"main","epoch":claim["epoch"],"head":claim["head"],"merge":batch,"landed":tickets}));
    for n in [2, 3] {
        assert_eq!(status(n)["status"], "landed", "change {n}");
        assert_eq!(status(n)["landed_version"], json!(version()));
    }
}

#[test]
fn change_events_reach_change_hooks_with_text_only_for_whole_repository_hooks() {
    let (h, root) = seeded();
    let hook = |paths: Value| {
        h.ok(
            OWNER,
            json!({"op":"repo_hook_create","url":"https://ci.example.com/hook",
            "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":"r0123456789abcdef0123",
            "_workers_subdomain":"mlong-f01","events":["change"],"paths":paths}),
        )["id"]
            .clone()
    };
    let (whole, docs) = (hook(Value::Null), hook(json!(["docs/"])));
    let head = push(&h, "fix", &root, "src/retry.rs");
    open(&h, AGENT, "fix").unwrap();
    h.ok(OWNER, json!({"op":"repo_change_comment","number":1,"body":"Nice.","path":"src/retry.rs","line":1,"side":"new"}));
    h.approve_and_check(&head);
    let landed = h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":head}));
    h.ok(HOOKS, json!({"op":"repo_hooks_fanout"}));
    let drain = |id: &Value| -> Vec<Value> {
        h.db.query(
            "SELECT payload FROM hook_outbox WHERE hook_id=? ORDER BY seq",
            std::slice::from_ref(id),
        )
        .unwrap()
        .iter()
        .map(|r| serde_json::from_str(r["payload"].as_str().unwrap()).unwrap())
        .collect()
    };
    let events = drain(&whole);
    let names: Vec<&str> = events
        .iter()
        .map(|e| e["event"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        ["change.opened", "change.commented", "change.landed"]
    );
    assert_eq!(
        events[0]["message"],
        "Retry with backoff\n\nFixes flaky fetches."
    );
    assert_eq!(events[1]["message"], "Nice.");
    assert_eq!(events[1]["comment"]["path"], "src/retry.rs");
    assert_eq!(
        (&events[2]["version"], &events[2]["change"]["status"]),
        (&landed["version"], &json!("landed"))
    );
    assert_eq!(events[2]["commit"], json!(head));
    // The path-restricted hook gets the same events without any text.
    let restricted = drain(&docs);
    assert_eq!(restricted.len(), 3);
    assert!(restricted.iter().all(|e| e.get("message").is_none()));
}

#[test]
fn upgrades_from_the_sessions_schema_with_empty_change_tables() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..27])
        .unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(
        db.query("SELECT number FROM changes", &[])
            .unwrap()
            .is_empty()
    );
    assert!(
        db.query("SELECT id FROM change_comments", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        migrations.last().unwrap().0
    );
    assert_eq!(
        db.query("SELECT owner FROM repo_settings", &[]).unwrap()[0]["owner"],
        "user:owner"
    );
}
