//! Break-glass recovery: only a signed-in human owner, a reason every time, the head the
//! human saw, idempotent retries, a loud audit trail and refs that only move forward.
use super::*;
use crate::storage::SqlStore;

const ACTIONS: [&str; 5] = [
    "land",
    "revert",
    "release_land_lease",
    "pause_automation",
    "resume_automation",
];

/// Runs `c` as an explicit credential object (as the adapter would attach it).
fn as_caller(h: &Harness, credential: Value, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    for (key, value) in credential.as_object().unwrap() {
        c[key] = value.clone();
    }
    execute_repo_store(&h.db, c)
}
fn person() -> Value {
    json!({"_session": {"workspace": "ws-1", "principal": OWNER, "human": true}})
}
fn human(h: &Harness, c: Value) -> yoneda_core::Result<Value> {
    as_caller(h, person(), c)
}
fn glass(h: &Harness, c: Value) -> Value {
    human(h, c.clone()).unwrap_or_else(|e| panic!("{c} failed: {e}"))
}
fn audit_rows(h: &Harness) -> usize {
    h.db.query("SELECT seq FROM break_glass", &[])
        .unwrap()
        .len()
}
fn child_of(h: &Harness, parent: &str, text: &str) -> String {
    h.commit(
        AGENT,
        Some(parent),
        1,
        json!([file("src/lib.rs", text)]),
        json!([]),
    )
    .unwrap()
}

#[test]
fn every_non_human_caller_gets_the_same_refusal() {
    let (h, root) = seeded();
    let all = json!(["read", "write", "check", "review", "land"]);
    h.ok(OWNER, json!({"op":"repo_token_create","name":"full","scopes":all,"_secret":"full-secret-0123456789abcdef0123456789"}));
    h.ok(OWNER, json!({"op":"repo_token_create","name":"dir","scopes":all,"paths":["src/"],"_secret":"dir-secret-0123456789abcdef0123456789"}));
    let mut callers: Vec<Value> = ["agent", "ci", "full", "dir"]
        .iter()
        .map(|n| json!({"_token": format!("{n}-secret-0123456789abcdef0123456789")}))
        .collect();
    for system in [
        "checks",
        "projection",
        "import",
        "merge",
        "repair",
        "derive",
    ] {
        callers.push(json!({"_system": system}));
    }
    // An owner session that is not a personal account (admin bearer, scripts).
    callers.push(json!({"_session": {"workspace": "ws-1", "principal": "admin"}}));
    callers.push(json!({"_session": {"workspace": "ws-1", "principal": OWNER, "human": "true"}}));
    // Identity fields are the adapter's: a token claiming humanity is still a token.
    callers.push(json!({"_token": "full-secret-0123456789abcdef0123456789", "human": true}));
    for caller in callers {
        for action in ACTIONS {
            let command = json!({"op":"repo_break_glass","action":action,"ref":"main","commit":root,
                "expected_old":root,"expected_epoch":null,"reason":"automation is down"});
            let refused = as_caller(&h, caller.clone(), command).unwrap_err();
            assert_eq!(
                (refused.code.as_str(), refused.message.as_str()),
                (
                    "FORBIDDEN",
                    "Break-glass recovery is only for a signed-in human owner"
                ),
                "{caller} {action}"
            );
        }
    }
    let stranger = json!({"_session": {"workspace": "ws-2", "principal": "user:x", "human": true}});
    assert_eq!(
        code(as_caller(
            &h,
            stranger,
            json!({"op":"repo_break_glass","action":"pause_automation","reason":"x"})
        )),
        "FORBIDDEN"
    );
    assert_eq!(audit_rows(&h), 0);
}

#[test]
fn every_action_needs_a_reason() {
    let (h, root) = seeded();
    for action in ACTIONS {
        for reason in [json!(null), json!("   "), json!("x".repeat(2001))] {
            let command = json!({"op":"repo_break_glass","action":action,"ref":"main","commit":root,
                "expected_old":root,"expected_epoch":null,"reason":reason});
            assert_eq!(code(human(&h, command)), "INVALID_INPUT", "{action}");
        }
    }
    assert_eq!(audit_rows(&h), 0);
}

#[test]
fn land_bypasses_checks_on_the_seen_head_once_and_loudly() {
    let (h, root) = seeded();
    let child = child_of(&h, &root, "pub fn a() { 1 }\n");
    let sibling = child_of(&h, &root, "pub fn a() { 9 }\n");
    let land = |commit: &str, old: Value| {
        json!({"op":"repo_break_glass","action":"land","ref":"main","commit":commit,
            "expected_old":old,"reason":"check runner is down"})
    };
    let mut missing = land(&child, json!(root));
    missing.as_object_mut().unwrap().remove("expected_old");
    assert_eq!(code(human(&h, missing)), "INVALID_INPUT");
    assert_eq!(code(human(&h, land(&child, json!(child)))), "STALE_HEAD");
    assert_eq!(code(human(&h, land(&child, json!(null)))), "STALE_HEAD");
    let before = h.ok(OWNER, json!({"op":"repo_txlog"}))["entries"].clone();

    let landed = glass(&h, land(&child, json!(root)));
    assert_eq!(
        (landed["version"].clone(), landed["landed"].clone()),
        (json!(2), json!(true))
    );
    let again = glass(&h, land(&child, json!(root)));
    assert_eq!(
        (again["already"].clone(), again["version"].clone()),
        (json!(true), json!(2))
    );
    assert_eq!(audit_rows(&h), 1);

    let entries = h.ok(OWNER, json!({"op":"repo_txlog"}))["entries"].clone();
    assert_eq!(
        entries[0], before[0],
        "earlier log entries are never rewritten"
    );
    assert_eq!(entries[1]["actor"], "break-glass:user:owner");
    assert_eq!(entries[1]["old"], json!(root));
    let detail = h.ok(AGENT, json!({"op":"repo_commit","commit":child}));
    let record = &detail["break_glass"][0];
    assert_eq!(
        (record["action"].as_str(), record["reason"].as_str()),
        (Some("land"), Some("check runner is down"))
    );
    let bypassed: Value = serde_json::from_str(record["detail"].as_str().unwrap()).unwrap();
    assert_eq!(
        bypassed["bypassed_gates"]["missing_checks"],
        json!(["unit"])
    );
    let log = h.ok(AGENT, json!({"op":"repo_log","ref":"main"}));
    assert_eq!(log["commits"][0]["break_glass"], "land");
    assert_eq!(log["commits"][1]["break_glass"], Value::Null);

    // Not a reset: a commit off the current head cannot be forced onto it.
    assert_eq!(
        code(human(&h, land(&sibling, json!(child)))),
        "STALE_PARENT"
    );
    // Time travel replays the hash chain across the break-glass entry.
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main","at":1}))["commit"],
        root
    );
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main","at":2}))["commit"],
        child
    );

    // A human rejection still holds.
    let rejected = child_of(&h, &child, "pub fn a() { 2 }\n");
    h.ok(
        OWNER,
        json!({"op":"repo_review","commit":rejected,"decision":"reject","reason":"no"}),
    );
    assert_eq!(code(human(&h, land(&rejected, json!(child)))), "FORBIDDEN");
}

#[test]
fn revert_lands_only_the_owners_exact_inverse_on_the_head() {
    let (h, root) = seeded();
    let edit = child_of(&h, &root, "pub fn a() { 2 }\n");
    let blob = |t: &[u8]| yoneda_core::git_object::hash_object(ObjectKind::Blob, t);
    let (original, edited) = (blob(b"pub fn a() {}\n"), blob(b"pub fn a() { 2 }\n"));
    let revert = |extra: Value| {
        let mut c = json!({"op":"repo_break_glass","action":"revert","ref":"main","commit":edit,
            "expected_old":edit,"reason":"bad landing"});
        for (k, v) in extra.as_object().unwrap() {
            c[k] = v.clone();
        }
        c
    };
    assert_eq!(code(human(&h, revert(json!({})))), "NOT_LANDED");
    glass(
        &h,
        json!({"op":"repo_break_glass","action":"land","ref":"main","commit":edit,"expected_old":root,"reason":"ci down"}),
    );
    assert_eq!(
        code(human(&h, revert(json!({"expected_old": root})))),
        "STALE_HEAD"
    );
    let ready = glass(&h, revert(json!({})));
    assert_eq!(
        (ready["ready"].clone(), ready["head"].clone()),
        (json!(true), json!(edit))
    );

    let inverse =
        json!([{"path": "src/lib.rs", "blob": original, "type": "blob", "expect": edited}]);
    let by_agent = h
        .commit(AGENT, Some(&edit), 2, inverse.clone(), json!([]))
        .unwrap();
    assert_eq!(
        code(human(&h, revert(json!({"revert_commit": by_agent})))),
        "FORBIDDEN"
    );
    let wrong = h
        .commit(
            OWNER,
            Some(&edit),
            2,
            json!([file("src/lib.rs", "pub fn a() { 0 }\n")]),
            json!([]),
        )
        .unwrap();
    assert_eq!(
        code(human(&h, revert(json!({"revert_commit": wrong})))),
        "INVALID_INPUT"
    );
    let off_head = h
        .commit(OWNER, Some(&root), 1, json!([file("x", "x\n")]), json!([]))
        .unwrap();
    assert_eq!(
        code(human(&h, revert(json!({"revert_commit": off_head})))),
        "INVALID_INPUT"
    );
    let undo = h.commit(OWNER, Some(&edit), 2, inverse, json!([])).unwrap();
    let landed = glass(&h, revert(json!({"revert_commit": undo})));
    assert_eq!(
        (landed["version"].clone(), landed["reverted"].clone()),
        (json!(3), json!(edit))
    );
    let retry = glass(&h, revert(json!({"revert_commit": undo})));
    assert_eq!(
        (retry["already"].clone(), retry["commit"].clone()),
        (json!(true), json!(undo))
    );
    assert_eq!(audit_rows(&h), 2);
    let entries = h.ok(OWNER, json!({"op":"repo_txlog"}))["entries"].clone();
    assert_eq!(
        (entries[2]["kind"].as_str(), entries[2]["actor"].as_str()),
        (Some("revert"), Some("break-glass:user:owner"))
    );
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_snapshot","ref":"main"}))["commit"],
        undo
    );
    let detail = h.ok(OWNER, json!({"op":"repo_commit","commit":edit}));
    assert_eq!(
        detail["break_glass"].as_array().unwrap().len(),
        2,
        "landed, then reverted"
    );
}

#[test]
fn stuck_lease_release_and_automation_pause_are_owner_recoveries() {
    let (h, root) = seeded();
    let queued = child_of(&h, &root, "pub fn a() { 5 }\n");
    h.db.query("INSERT INTO land_leases(refname,epoch,expires_at) VALUES('refs/heads/main',4,9999999999999)", &[]).unwrap();
    h.db.query("INSERT INTO land_queue(refname,commit_id,principal,status,requested_at) VALUES('refs/heads/main',?,'token:agent','pending',1)", &[json!(queued)]).unwrap();
    let state = h.ok(OWNER, json!({"op":"repo_status"}))["automation"].clone();
    assert_eq!(
        (
            state["land_leases"][0]["epoch"].clone(),
            state["pending_landings"].clone()
        ),
        (json!(4), json!(1))
    );
    let release = |epoch: Value| {
        json!({"op":"repo_break_glass","action":"release_land_lease","ref":"main",
            "expected_epoch":epoch,"cancel_pending":true,"reason":"merger is down"})
    };
    assert_eq!(code(human(&h, release(json!(null)))), "STALE_EPOCH");
    assert_eq!(code(human(&h, release(json!(3)))), "STALE_EPOCH");
    let released = glass(&h, release(json!(4)));
    assert_eq!(
        (
            released["released"].clone(),
            released["cancelled_pending"].clone()
        ),
        (json!(true), json!(1))
    );
    assert_eq!(glass(&h, release(json!(null)))["already"], true);
    let ticket =
        h.db.query("SELECT status,result FROM land_queue", &[])
            .unwrap();
    assert_eq!(ticket[0]["status"], "failed");
    assert!(
        ticket[0]["result"]
            .as_str()
            .unwrap()
            .contains("BREAK_GLASS")
    );

    let pause = |action: &str| json!({"op":"repo_break_glass","action":action,"reason":"agents misbehaving"});
    assert_eq!(glass(&h, pause("resume_automation"))["already"], true);
    assert_eq!(glass(&h, pause("pause_automation"))["paused"], true);
    assert_eq!(glass(&h, pause("pause_automation"))["already"], true);
    let check = json!({"op":"repo_check","commit":queued,"name":"unit","status":"pass"});
    assert_eq!(code(h.run(CI, check.clone())), "AUTOMATION_PAUSED");
    assert_eq!(
        code(h.run(
            SYSTEM,
            json!({"op":"repo_check_claim","run_id":"cr_x","now":1})
        )),
        "AUTOMATION_PAUSED"
    );
    assert_eq!(
        code(h.run(
            "platform:merge",
            json!({"op":"repo_land_claim","ref":"main"})
        )),
        "AUTOMATION_PAUSED"
    );
    // Reads, commit recording and the owner keep working while automation is paused.
    h.ok(AGENT, json!({"op":"repo_status"}));
    child_of(&h, &root, "pub fn a() { 6 }\n");
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_status"}))["automation"]["paused"]["reason"],
        "agents misbehaving"
    );
    glass(&h, pause("resume_automation"));
    h.ok(CI, check);
    assert_eq!(audit_rows(&h), 3);
}

#[test]
fn clone_access_is_only_for_a_person_reading_the_whole_repository() {
    let (h, _root) = seeded();
    let access = json!({"op": "repo_clone_access"});
    let granted = as_caller(&h, person(), access.clone()).unwrap();
    assert!(granted["object_store"].is_string());
    // The same owner without the human marker (an admin script) and every token are refused.
    let script = json!({"_session": {"workspace": "ws-1", "principal": OWNER}});
    assert_eq!(code(as_caller(&h, script, access.clone())), "FORBIDDEN");
    assert_eq!(code(h.run(AGENT, access)), "FORBIDDEN");
}
