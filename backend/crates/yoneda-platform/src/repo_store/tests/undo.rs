//! The undo window at the authority: a purge waits for its due time, a restore brings a
//! tombstone back until the first purge starts, and from then on it never can. The window's
//! length comes from the adapter (`_undo_ms`, `REPO_UNDO_DAYS`); without one, nothing waits,
//! as before. The adapter's half is `tests/workers/repo-undo.test.ts`.
use super::*;
use crate::repo_store::rows;

/// The owner's own signed-in session: the one caller that may purge now.
const PERSON: &str = "member:ws-1";
const PURGE: &str = "platform:purge";
const ERASE: &str = "platform:erase";
const HOOKS: &str = "platform:hooks";
const QUARANTINE: &str = "platform:quarantine";
const REPO: &str = "r0123456789abcdef0123";
/// Longer than any test's clock, which moves a second per command.
const WINDOW: i64 = 30 * 24 * 60 * 60 * 1000;

/// A command as the adapter signs it with the window on.
fn windowed(mut command: Value) -> Value {
    command["_undo_ms"] = json!(WINDOW);
    command
}

fn delete(h: &Harness) -> Value {
    h.ok(
        OWNER,
        windowed(json!({"op":"repo_delete","confirm":"demo"})),
    )
}

fn purge_target(h: &Harness) -> Result<Value, yoneda_core::Error> {
    h.run(PURGE, windowed(json!({"op":"repo_purge_target"})))
}

/// The clock past the window of a repository deleted just now.
fn pass_window(h: &Harness) {
    *h.now.borrow_mut() += WINDOW;
}

fn restore(h: &Harness, name: Option<&str>) -> Value {
    h.ok(OWNER, json!({"op":"repo_restore","name":name}))
}

fn hook(h: &Harness) -> Value {
    h.ok(
        OWNER,
        json!({"op":"repo_hook_create","url":"https://example.com/hook","events":["repo"],
               "_secret":"whsec_0123456789abcdef0123456789abcdef","_repo":REPO}),
    )["id"]
        .clone()
}

/// Claims and settles every payload waiting for `hook`.
fn drain(h: &Harness, hook: &Value) -> Vec<Value> {
    let mut bodies = Vec::new();
    loop {
        let claim = h.ok(HOOKS, json!({"op":"repo_hook_claim","hook_id":hook}));
        if claim["idle"] == true {
            return bodies;
        }
        bodies.push(serde_json::from_str::<Value>(claim["body"].as_str().unwrap()).unwrap());
        h.ok(
            HOOKS,
            json!({"op":"repo_hook_settle","hook_id":hook,"seq":claim["seq"],
                   "attempt":claim["attempt"],"ok":true,"status":200,"ms":1}),
        );
    }
}

#[test]
fn a_purge_is_refused_until_the_window_has_passed() {
    let h = Harness::new();
    let deleted = delete(&h);
    assert_eq!(
        deleted["purge_at"],
        json!(deleted["deleted_at"].as_i64().unwrap() + WINDOW)
    );
    let refused = purge_target(&h).unwrap_err();
    assert_eq!(refused.code, "NOT_DUE");
    assert_eq!(refused.message, deleted["purge_at"].to_string());
    pass_window(&h);
    assert_eq!(
        purge_target(&h).unwrap()["object_store"],
        "artifacts:test/demo"
    );
}

#[test]
fn without_a_window_nothing_waits() {
    let h = Harness::new();
    let deleted = h.ok(OWNER, json!({"op":"repo_delete","confirm":"demo"}));
    assert_eq!(deleted["purge_at"], Value::Null);
    assert_eq!(code(h.run(PURGE, json!({"op":"repo_purge_target"}))), "OK");
}

#[test]
fn the_platform_can_skip_the_window_and_the_erase_follows_a_purge_that_started() {
    let h = Harness::new();
    delete(&h);
    assert!(h.ok(ERASE, windowed(json!({"op":"repo_erase_plan"})))["not_due"].is_i64());
    assert_eq!(
        code(h.run(ERASE, windowed(json!({"op":"repo_erase_step"})))),
        "NOT_DUE"
    );
    // A failed create's take-back and an operator's purge: the adapter sends no window.
    assert_eq!(code(h.run(PURGE, json!({"op":"repo_purge_target"}))), "OK");
    assert!(h.ok(ERASE, windowed(json!({"op":"repo_erase_plan"})))["refs"].is_array());
    assert_eq!(
        code(h.run(PURGE, windowed(json!({"op":"repo_purge_target"})))),
        "OK"
    );
    assert_eq!(
        code(h.run(ERASE, windowed(json!({"op":"repo_erase_step"})))),
        "OK"
    );
}

#[test]
fn restoring_brings_a_tombstone_back_with_its_tokens_still_revoked() {
    let h = Harness::new();
    delete(&h);
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_refs"}))), "GONE");
    let checked = h.ok(OWNER, json!({"op":"repo_restore","check":true}));
    assert_eq!(checked["name"], "demo");
    assert_eq!(checked["workspace"], "ws-1");
    assert_eq!(checked["visibility"], "private");
    assert!(checked["created_at"].is_i64());
    assert_eq!(checked["parent"], Value::Null);
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_refs"}))),
        "GONE",
        "a check changes nothing"
    );

    let restored = restore(&h, None);
    assert_eq!(restored["name"], "demo");
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_refs"}))), "OK");
    assert!(rows::settings(&h.db).unwrap().deleted_at.is_none());
    assert_eq!(
        code(h.run("token:agent", json!({"op":"repo_refs"}))),
        "UNAUTHORIZED"
    );
    // Nothing left to purge, and a repeat tells so.
    assert_eq!(
        code(h.run(PURGE, json!({"op":"repo_purge_target"}))),
        "NOT_FOUND"
    );
    assert_eq!(restore(&h, None)["already"], true);
}

#[test]
fn a_restore_may_take_a_new_name_and_only_a_valid_one() {
    let h = Harness::new();
    delete(&h);
    let bad = h.run(OWNER, json!({"op":"repo_restore","name":".hidden"}));
    assert_eq!(code(bad), "INVALID_INPUT");
    assert_eq!(restore(&h, Some("demo-2"))["name"], "demo-2");
    assert_eq!(rows::settings(&h.db).unwrap().name, "demo-2");
}

#[test]
fn only_the_owners_account_restores_and_everyone_else_is_told_gone() {
    let h = Harness::new();
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"dana","role":"admin"}),
    );
    delete(&h);
    for who in ["member:dana", "platform:fork"] {
        assert_eq!(
            code(h.run(who, json!({"op":"repo_restore"}))),
            "GONE",
            "{who}"
        );
        assert_eq!(
            code(h.run(who, json!({"op":"repo_restore","check":true}))),
            "GONE",
            "{who}"
        );
    }
    assert!(rows::settings(&h.db).unwrap().deleted_at.is_some());
    // The platform reads what it needs to list a tombstone, and restores nothing.
    let read = h.ok(PURGE, windowed(json!({"op":"repo_restore","check":true})));
    assert_eq!(read["workspace"], "ws-1");
    assert_eq!(code(h.run(PURGE, json!({"op":"repo_restore"}))), "GONE");
}

#[test]
fn a_live_repository_restores_nothing_for_anyone_but_its_owner() {
    let h = Harness::new();
    let refused = h.run("token:agent", json!({"op":"repo_restore"}));
    assert_eq!(code(refused), "FORBIDDEN");
    assert_eq!(restore(&h, None)["already"], true);
}

#[test]
fn once_a_purge_has_started_nothing_restores() {
    let h = Harness::new();
    delete(&h);
    pass_window(&h);
    purge_target(&h).unwrap();
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_restore","check":true}))),
        "GONE"
    );
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_restore"}))), "GONE");
    assert!(rows::settings(&h.db).unwrap().deleted_at.is_some());
    // A repeated delete says so, and leaves it alone.
    assert_eq!(delete(&h)["purge_started"], true);
}

fn purge_now(h: &Harness) -> Value {
    h.ok(PERSON, json!({"op":"repo_purge_now"}))
}

#[test]
fn its_owner_purges_it_now_and_nothing_brings_it_back() {
    let h = Harness::new();
    delete(&h);
    let started = purge_now(&h);
    assert_eq!(started["workspace"], "ws-1");
    assert_eq!(started["name"], "demo");
    assert_eq!(started["finished"], false);
    assert!(rows::settings(&h.db).unwrap().purge_started());
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_restore"}))), "GONE");
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_restore","check":true}))),
        "GONE"
    );
    // The window no longer holds the job back, as this mark is the owner's word.
    assert_eq!(code(purge_target(&h)), "OK");
}

#[test]
fn a_repeated_purge_changes_nothing_and_says_when_it_finished() {
    let h = Harness::new();
    let id = hook(&h);
    delete(&h);
    purge_now(&h);
    assert_eq!(purge_now(&h)["finished"], false);
    h.ok(PURGE, json!({"op":"repo_purged"}));
    assert_eq!(purge_now(&h)["finished"], true);
    h.ok(PURGE, json!({"op":"repo_purged"}));
    let events: Vec<Value> = drain(&h, &id).iter().map(|b| b["event"].clone()).collect();
    assert_eq!(events, [json!("repo.deleted"), json!("repo.purged")]);
}

#[test]
fn only_the_owners_account_purges_and_everyone_else_is_told_gone() {
    let h = Harness::new();
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"dana","role":"admin"}),
    );
    delete(&h);
    for who in ["member:dana", "platform:fork", "platform:purge"] {
        assert_eq!(
            code(h.run(who, json!({"op":"repo_purge_now"}))),
            "GONE",
            "{who}"
        );
    }
    assert!(!rows::settings(&h.db).unwrap().purge_started());
    assert_eq!(restore(&h, None)["name"], "demo");
}

/// The owner's token, as the adapter signs it: account-wide, holding every repository scope.
fn pat(h: &Harness, command: Value) -> yoneda_core::Result<Value> {
    let mut c = command;
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    c["_pat"] = json!({"workspace": "ws-1", "principal": OWNER, "id": "pat_0123456789abcdef",
        "scopes": ["repo:admin"], "repos": null});
    c["_hold"] = json!("off");
    crate::repo_store::execute_repo_store(&h.db, c)
}

#[test]
fn a_purge_needs_a_person_and_a_token_is_told_so() {
    let h = Harness::new();
    delete(&h);
    // A session no person holds (an admin bearer acting as the account), and a token.
    let session = h.run(OWNER, json!({"op":"repo_purge_now"})).unwrap_err();
    let token = pat(&h, json!({"op":"repo_purge_now"})).unwrap_err();
    for refused in [session, token] {
        assert_eq!(refused.code, "FORBIDDEN");
        assert!(refused.message.contains("signed in"), "{}", refused.message);
        assert!(!refused.message.contains("Break-glass"));
    }
    assert!(!rows::settings(&h.db).unwrap().purge_started());
    // The undo window is still there: the same token restores it.
    assert_eq!(code(pat(&h, json!({"op":"repo_restore"}))), "OK");
}

#[test]
fn a_live_repository_has_nothing_to_purge() {
    let h = Harness::new();
    assert_eq!(
        code(h.run("token:agent", json!({"op":"repo_purge_now"}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(PERSON, json!({"op":"repo_purge_now"}))),
        "CONFLICT"
    );
    assert!(!rows::settings(&h.db).unwrap().purge_started());
}

#[test]
fn an_erased_tombstone_has_nobody_left_to_purge_it() {
    let h = Harness::new();
    delete(&h);
    purge_now(&h);
    while h.ok(ERASE, json!({"op":"repo_erase_step"}))["done"] != true {}
    assert_eq!(code(h.run(PERSON, json!({"op":"repo_purge_now"}))), "GONE");
}

#[test]
fn past_its_due_time_a_repository_no_purge_reached_still_restores() {
    let h = Harness::new();
    delete(&h);
    pass_window(&h);
    assert_eq!(restore(&h, None)["name"], "demo");
}

#[test]
fn a_restore_check_names_the_store_and_the_head_to_look_for() {
    use crate::storage::SqlStore;
    let h = Harness::new();
    delete(&h);
    let check = h.ok(OWNER, json!({"op":"repo_restore","check":true}));
    let settings = rows::settings(&h.db).unwrap();
    assert_eq!(check["object_store"], settings.object_store.as_str());
    assert_eq!(
        check["head"],
        Value::Null,
        "a repository with no refs loses nothing"
    );

    h.db.query(
        "INSERT INTO refs(name,commit_id,version) VALUES('refs/heads/side','aaa',1),('refs/heads/main','bbb',2)",
        &[],
    )
    .unwrap();
    let check = h.ok(OWNER, json!({"op":"repo_restore","check":true}));
    assert_eq!(
        check["head"],
        json!({"commit":"bbb","bundle":null,"staged":false})
    );

    h.db.query(
        "INSERT INTO bundled_objects(id,bundle,at,size,kind) VALUES('bbb','b1',0,1,'commit')",
        &[],
    )
    .unwrap();
    h.db.query(
        "INSERT INTO staged_objects(commit_id,id,kind,data_b64) VALUES('bbb','bbb','commit','')",
        &[],
    )
    .unwrap();
    let check = h.ok(OWNER, json!({"op":"repo_restore","check":true}));
    assert_eq!(
        check["head"],
        json!({"commit":"bbb","bundle":"b1","staged":true})
    );
}

#[test]
fn a_restored_repository_deleted_again_waits_a_new_window() {
    let h = Harness::new();
    let first = delete(&h);
    restore(&h, None);
    *h.now.borrow_mut() += WINDOW / 2;
    let second = delete(&h);
    assert_eq!(second["already"], false);
    assert!(second["purge_at"].as_i64() > first["purge_at"].as_i64());
    pass_window(&h);
    *h.now.borrow_mut() -= WINDOW / 2;
    assert_eq!(purge_target(&h).unwrap_err().code, "NOT_DUE");
}

#[test]
fn repo_deleted_names_the_due_time_and_repo_purged_fires_once() {
    let h = Harness::new();
    let hook = hook(&h);
    delete(&h);
    let bodies = drain(&h, &hook);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["event"], "repo.deleted");
    assert!(bodies[0]["purge_at"].is_string(), "{}", bodies[0]);

    pass_window(&h);
    purge_target(&h).unwrap();
    let first = h.ok(PURGE, json!({"op":"repo_purged"}));
    assert_eq!(first["hooks"], json!([hook]));
    assert_eq!(first["workspace"], "ws-1");
    // A retried job: the same payload is named again until it is delivered, and never doubled.
    assert_eq!(
        h.ok(PURGE, json!({"op":"repo_purged"}))["hooks"],
        json!([hook])
    );
    let bodies = drain(&h, &hook);
    assert_eq!(bodies.len(), 1);
    assert_eq!(bodies[0]["event"], "repo.purged");
    assert_eq!(bodies[0]["action"], "purged");
    assert_eq!(bodies[0]["repo"], REPO);
    assert_eq!(h.ok(PURGE, json!({"op":"repo_purged"}))["hooks"], json!([]));
    assert_eq!(drain(&h, &hook), Vec::<Value>::new());
}

#[test]
fn a_purged_tombstone_is_erased_after_repo_purged_is_delivered() {
    let h = Harness::new();
    let hook = hook(&h);
    delete(&h);
    drain(&h, &hook);
    pass_window(&h);
    purge_target(&h).unwrap();
    h.ok(PURGE, json!({"op":"repo_purged"}));
    assert_eq!(
        h.ok(ERASE, json!({"op":"repo_erase_plan"}))["hooks"],
        json!([hook])
    );
    drain(&h, &hook);
    let step = json!({"op":"repo_erase_step"});
    while h.ok(ERASE, step.clone())["done"] != true {}
    // Whatever repeats after the erase has nothing left to do.
    let done = h.ok(PURGE, json!({"op":"repo_purged"}));
    assert_eq!(done["hooks"], json!([]));
    assert_eq!(done["workspace"], "");
}

#[test]
fn only_the_platform_reports_a_purge() {
    let h = Harness::new();
    delete(&h);
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_purged"}))), "GONE");
    assert_eq!(code(h.run(HOOKS, json!({"op":"repo_purged"}))), "GONE");
    let live = Harness::new();
    assert_eq!(
        code(live.run(PURGE, json!({"op":"repo_purged"}))),
        "NOT_FOUND"
    );
    assert_eq!(
        code(live.run(OWNER, json!({"op":"repo_purged"}))),
        "FORBIDDEN"
    );
}

#[test]
fn a_hold_freezes_the_purge_of_a_due_repository_and_leaves_restore_alone() {
    let h = Harness::new();
    delete(&h);
    pass_window(&h);
    let mut held = windowed(json!({"op":"repo_purge_target"}));
    held["_hold"] = json!({"held": true});
    assert_eq!(code(h.run(PURGE, held)), "LEGAL_HOLD");
    // Refused before it could mark anything, so the repository is intact.
    let mut restoring = json!({"op":"repo_restore"});
    restoring["_hold"] = json!({"held": true});
    assert_eq!(h.ok(OWNER, restoring)["name"], "demo");
}

#[test]
fn quarantine_keeps_running_on_a_tombstone_until_its_purge_starts() {
    let h = Harness::new();
    let target = "a".repeat(40);
    h.ok(
        OWNER,
        json!({"op":"repo_quarantine","target":{"kind":"blob","id":target},"path":"leak.txt",
               "reason":"secret","retain_days":1}),
    );
    delete(&h);
    *h.now.borrow_mut() += WINDOW / 15;
    // What the job reads, and only the job: everyone else still gets GONE.
    assert_eq!(code(h.run(QUARANTINE, json!({"op":"repo_status"}))), "OK");
    assert_eq!(code(h.run(OWNER, json!({"op":"repo_status"}))), "GONE");
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_quarantine_claim","limit":1}))),
        "GONE"
    );
    let claimed = h.ok(QUARANTINE, json!({"op":"repo_quarantine_claim","limit":10}));
    let claims = claimed["claims"].as_array().unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0]["target"]["id"], target.as_str());
    let reported = json!({"op":"repo_quarantine_purged",
        "claims":[{"id":claims[0]["id"],"epoch":claims[0]["epoch"]}]});
    assert_eq!(code(h.run(QUARANTINE, reported)), "OK");

    pass_window(&h);
    purge_target(&h).unwrap();
    assert_eq!(
        code(h.run(QUARANTINE, json!({"op":"repo_quarantine_claim","limit":1}))),
        "GONE"
    );
}
