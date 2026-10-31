//! Legal hold at the authority: destructive ops run only on the adapter's verified answer,
//! nothing else notices. The answers themselves come from the owner's account authority
//! (`accounts::holds`), tested there; the adapter's half is `tests/workers/legal-hold.test.ts`.
use super::batches::open;
use super::*;
use crate::commit_store::{execute_commit_store, migrate_commit_store};
use crate::repo_store::legal_hold::refuses;
use crate::repo_store::op::Op;

/// What the adapter sends once the owner's authority answers.
fn answered(mut command: Value, held: bool) -> Value {
    command["_hold"] = json!({ "held": held });
    command
}
/// A command with no answer: what reaches the authority before the adapter asks.
fn unchecked(mut command: Value) -> Value {
    command["_hold"] = Value::Null;
    command
}

fn delete() -> Value {
    json!({"op":"repo_delete","confirm":"demo"})
}

/// One of every op the list holds back, as a caller allowed to run it sends it.
fn destructive() -> Vec<(&'static str, Value)> {
    vec![
        (OWNER, delete()),
        ("platform:purge", json!({"op":"repo_purge_target"})),
        (OWNER, json!({"op":"repo_release_delete","tag":"v1"})),
        (OWNER, json!({"op":"repo_change_delete","number":1})),
        (OWNER, json!({"op":"repo_vacuum_plan"})),
        (OWNER, json!({"op":"repo_quarantine_purge","id":1})),
        (
            "platform:quarantine",
            json!({"op":"repo_quarantine_claim","limit":1}),
        ),
        ("platform:quarantine", json!({"op":"repo_mirror_claim"})),
        (
            "platform:quarantine",
            json!({"op":"repo_mirror_switch","epoch":1}),
        ),
    ]
}

#[test]
fn the_list_is_exactly_the_destructive_ops() {
    let mut refused: Vec<_> = Op::all()
        .into_iter()
        .filter_map(|op| match op {
            Op::Store(op) if refuses(op) => Some(op.name()),
            _ => None,
        })
        .collect();
    refused.sort_unstable();
    assert_eq!(
        refused,
        [
            "repo_change_delete",
            "repo_delete",
            "repo_mirror_claim",
            "repo_mirror_switch",
            "repo_purge_target",
            "repo_quarantine_claim",
            "repo_quarantine_purge",
            "repo_release_delete",
            "repo_vacuum_plan",
        ]
    );
}

#[test]
fn without_an_answer_every_destructive_op_is_refused_and_names_the_owner() {
    let h = Harness::new();
    for (principal, command) in destructive() {
        let refused = h.run(principal, unchecked(command.clone())).unwrap_err();
        assert_eq!(refused.code, "HOLD_UNCHECKED", "{command}");
        assert_eq!(refused.message, "ws-1", "{command}");
    }
}

#[test]
fn a_held_owner_refuses_every_destructive_op() {
    let h = Harness::new();
    for (principal, command) in destructive() {
        let refused = h.run(principal, answered(command.clone(), true));
        assert_eq!(code(refused), "LEGAL_HOLD", "{command}");
    }
    assert_eq!(h.ok(OWNER, json!({"op":"repo_status"}))["version"], 0);
}

#[test]
fn an_answer_that_says_free_lets_the_op_run_and_off_skips_the_check() {
    let h = Harness::new();
    assert_eq!(
        h.ok(OWNER, answered(delete(), false))["deleted"],
        json!(true)
    );
    let h = Harness::new();
    let mut off = delete();
    off["_hold"] = json!("off");
    assert_eq!(h.ok(OWNER, off)["deleted"], json!(true));
}

#[test]
fn anything_but_a_verified_answer_fails_closed() {
    let h = Harness::new();
    for hold in [
        json!(true),
        json!(false),
        json!("on"),
        json!(0),
        json!({}),
        json!({"held":"no"}),
        json!({"held":null}),
        json!([]),
    ] {
        let mut command = delete();
        command["_hold"] = hold.clone();
        assert_eq!(code(h.run(OWNER, command)), "HOLD_UNCHECKED", "{hold}");
    }
}

#[test]
fn who_may_run_an_op_is_decided_before_the_hold() {
    let h = Harness::new();
    let refused = h.run(
        CI,
        unchecked(json!({"op":"repo_release_delete","tag":"v1"})),
    );
    assert_eq!(code(refused), "FORBIDDEN");
    let stranger = h.run(
        "member:stranger",
        unchecked(json!({"op":"repo_vacuum_plan"})),
    );
    assert_eq!(code(stranger), "NOT_FOUND");
}

#[test]
fn a_tombstone_under_a_hold_keeps_its_data_until_released() {
    let h = Harness::new();
    h.ok(OWNER, answered(delete(), false));
    let purge = json!({"op":"repo_purge_target"});
    assert_eq!(
        code(h.run("platform:purge", answered(purge.clone(), true))),
        "LEGAL_HOLD"
    );
    assert_eq!(
        code(h.run("platform:purge", unchecked(purge.clone()))),
        "HOLD_UNCHECKED"
    );
    let free = h.ok("platform:purge", answered(purge, false));
    assert_eq!(free["name"], "demo");
}

#[test]
fn withholding_landing_compaction_and_branch_work_ignore_the_hold() {
    let (h, root) = open();
    let quarantined = h.ok(
        OWNER,
        unchecked(
            json!({"op":"repo_quarantine","target":{"kind":"blob","id":"a".repeat(40)},
            "path":"x","reason":"leaked"}),
        ),
    );
    h.ok(
        OWNER,
        unchecked(json!({"op":"repo_quarantine_release","id":quarantined["record"]["id"]})),
    );
    assert_eq!(
        code(h.run(
            OWNER,
            unchecked(json!({"op":"repo_branch_set","ref":"gone","commit":root}))
        )),
        "OK"
    );
    for (principal, command) in [
        (OWNER, json!({"op":"repo_compact_plan"})),
        (OWNER, json!({"op":"repo_member_remove","account":"nobody"})),
        (
            "platform:lfs",
            json!({"op":"repo_lfs_sweep_claim","limit":1}),
        ),
    ] {
        let answer = code(h.run(principal, unchecked(command.clone())));
        assert!(
            !["HOLD_UNCHECKED", "LEGAL_HOLD"].contains(&answer.as_str()),
            "{command}: {answer}"
        );
    }
}

/// Landing never looks at `_hold`: with the check on (no answer sent, as the adapter sends
/// none for landing), it runs the same statements as with it off.
#[test]
fn landing_costs_no_statement_with_the_hold_on() {
    let land = |hold: Value| {
        let (h, root) = open();
        let id = h
            .commit(
                AGENT,
                Some(&root),
                1,
                json!([file("x.txt", "x\n")]),
                json!([]),
            )
            .unwrap();
        let mut command = json!({"op":"repo_land","ref":"main","commit":id});
        command["_hold"] = hold;
        let before = h.db.counts();
        h.ok(OWNER, command);
        h.db.counts() - before
    };
    let (off, on) = (land(json!("off")), land(Value::Null));
    assert_eq!(off.statements, on.statements);
    assert!(on.statements > 0);
}

#[test]
fn the_owner_is_answered_to_members_and_the_platform_even_on_a_tombstone() {
    let h = Harness::new();
    let owner = json!({"op":"repo_hold_owner"});
    assert_eq!(h.ok(OWNER, owner.clone())["owner"], "ws-1");
    assert_eq!(h.ok(AGENT, owner.clone())["owner"], "ws-1");
    assert_eq!(h.ok("platform:purge", owner.clone())["owner"], "ws-1");
    assert_eq!(code(h.run("member:stranger", owner.clone())), "NOT_FOUND");
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    assert_eq!(code(h.run("member:stranger", owner.clone())), "FORBIDDEN");
    h.ok(OWNER, answered(delete(), false));
    assert_eq!(h.ok("platform:purge", owner.clone())["owner"], "ws-1");
    assert_eq!(code(h.run(OWNER, owner)), "GONE");
}

#[test]
fn a_shard_forgets_commits_only_on_a_verified_answer() {
    let db = NativeStore::memory().unwrap();
    migrate_commit_store(&db).unwrap();
    let run = |hold: Value| {
        execute_commit_store(
            &db,
            json!({"op":"store_vacuum_delete","ids":[],"_system":"commits","_hold":hold}),
        )
    };
    assert_eq!(code(run(Value::Null)), "HOLD_UNCHECKED");
    assert_eq!(code(run(json!({"held":"no"}))), "HOLD_UNCHECKED");
    assert_eq!(code(run(json!({"held":true}))), "LEGAL_HOLD");
    assert_eq!(run(json!({"held":false})).unwrap()["deleted"], 0);
    assert_eq!(run(json!("off")).unwrap()["deleted"], 0);
}
