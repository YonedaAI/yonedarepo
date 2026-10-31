//! What a repository's database holds (`repo_storage`, for its owner and the platform) and
//! the refusal of new work near the size limit, which leaves accepted work running.
use super::batches::{credentials, open, outcome};
use super::*;
use crate::platform_compute;
use crate::repo_store::capacity::refuses;
use crate::repo_store::op::Op;

const MERGER: &str = "platform:merge";

#[test]
fn the_owner_and_the_platform_read_database_size_and_row_estimates() {
    let h = Harness::new();
    for principal in [OWNER, "platform:derive"] {
        let storage = h.ok(principal, json!({"op":"repo_storage"}));
        assert!(storage["db_bytes"].as_u64().unwrap() > 4096, "{storage}");
        assert_eq!(storage["table_rows"]["tokens"], json!(2));
        assert_eq!(storage["table_rows"]["commits"], json!(0));
    }
}

#[test]
fn nobody_else_reads_the_database_size() {
    let h = Harness::new();
    let refused = h.run(AGENT, json!({"op":"repo_storage"})).unwrap_err();
    assert_eq!(refused.code, "FORBIDDEN");
    let reader = h.run("member:stranger", json!({"op":"repo_storage"}));
    assert_eq!(reader.unwrap_err().code, "NOT_FOUND");
}

#[test]
fn a_public_reader_does_not_see_the_database_size() {
    let h = Harness::new();
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    let refused = h
        .run("member:stranger", json!({"op":"repo_storage"}))
        .unwrap_err();
    assert!(
        ["FORBIDDEN", "NOT_FOUND"].contains(&refused.code.as_ref()),
        "{refused}"
    );
}

/// Any database is over this limit; a real one is the same comparison.
fn at_limit(mut command: Value) -> Value {
    command["_storage_guard"] = json!(1);
    command
}

fn land(commit: &str) -> Value {
    json!({"op": "repo_land", "ref": "main", "commit": commit, "enqueue": true})
}

fn enqueue(commit: &str) -> Value {
    json!({"op": "repo_land_enqueue", "ref": "main", "commit": commit})
}

fn submitted(items: Value) -> Value {
    json!({"op": "repo_land_submitted", "ref": "main", "items": items})
}

fn item(record: &Value) -> Value {
    json!({"credentials": credentials(OWNER), "records": [record]})
}

#[test]
fn the_guard_refuses_exactly_the_ops_that_start_new_work() {
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
            "repo_begin_commit",
            "repo_import",
            "repo_prepare_commit",
            "repo_record_commit",
            "repo_record_imported",
            "repo_record_pushed",
        ]
    );
}

#[test]
fn new_work_answers_repo_full_at_the_limit_and_nothing_changes_below_it() {
    let (h, root) = open();
    let id = "0".repeat(40);
    for (principal, command) in [
        (
            AGENT,
            json!({"op":"repo_prepare_commit","ref":"main","changes":[file("x", "x\n")]}),
        ),
        (
            AGENT,
            json!({"op":"repo_begin_commit","ref":"main","paths":["x"]}),
        ),
        (AGENT, json!({"op":"repo_record_commit","commit":id})),
        (AGENT, json!({"op":"repo_record_pushed","commits":[]})),
        (
            OWNER,
            json!({"op":"repo_import","ref":"main","commit":root}),
        ),
        (
            "platform:import",
            json!({"op":"repo_record_imported","commit":id}),
        ),
    ] {
        let refused = h.run(principal, at_limit(command.clone())).unwrap_err();
        assert_eq!(refused.code, "REPO_FULL", "{command}");
        let mut below = command;
        below["_storage_guard"] = json!(u64::MAX >> 1);
        assert_ne!(code(h.run(principal, below)), "REPO_FULL");
    }
}

#[test]
fn a_caller_who_may_not_write_is_told_that_first() {
    let (h, _) = open();
    let command = at_limit(json!({"op":"repo_begin_commit","ref":"main","paths":["x"]}));
    assert_eq!(code(h.run(CI, command)), "FORBIDDEN");
}

#[test]
fn a_new_landing_is_refused_and_a_repeat_of_a_landed_one_answers_as_before() {
    let (h, root) = open();
    let change = json!([file("x.txt", "x\n")]);
    let id = h.commit(AGENT, Some(&root), 1, change, json!([])).unwrap();
    assert_eq!(code(h.run(OWNER, at_limit(land(&id)))), "REPO_FULL");
    assert_eq!(code(h.run(OWNER, at_limit(enqueue(&id)))), "REPO_FULL");
    assert_eq!(h.ok(OWNER, land(&id))["landed"], true);
    assert_eq!(h.ok(OWNER, at_limit(land(&id)))["already"], true);
    assert_eq!(h.ok(OWNER, at_limit(enqueue(&id)))["already"], true);
}

#[test]
fn a_landing_already_queued_keeps_its_ticket() {
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
    let ticket = h.ok(OWNER, enqueue(&id))["ticket"].clone();
    assert_eq!(h.ok(OWNER, at_limit(enqueue(&id)))["ticket"], ticket);
}

#[test]
fn a_batch_refuses_each_new_landing_alone_and_answers_those_already_accepted() {
    let (h, _) = open();
    let landed = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    assert_eq!(outcome(&h.submit(vec![(OWNER, &landed)]), 0).0, "landed");
    let same_file = h.shard_commit(AGENT, "a.txt", "other\n", json!([]));
    let queued = h.submit(vec![(OWNER, &same_file)]);
    let ticket = outcome(&queued, 0).1["ticket"].clone();
    let fresh = h.shard_commit(AGENT, "b.txt", "b\n", json!([]));
    let version = h.ok(OWNER, json!({"op":"repo_status"}))["version"].clone();
    let items = json!([item(&landed), item(&same_file), item(&fresh)]);
    let batch = h.ok(MERGER, at_limit(submitted(items)));
    assert_eq!(outcome(&batch, 0).0, "landed", "{batch}");
    assert_eq!(outcome(&batch, 0).1["already"], true);
    assert_eq!(outcome(&batch, 1).0, "queued", "{batch}");
    assert_eq!(outcome(&batch, 1).1["ticket"], ticket);
    let (status, refused) = outcome(&batch, 2);
    assert_eq!(status, "failed", "{batch}");
    assert_eq!(refused["code"], "REPO_FULL");
    assert_eq!(h.ok(OWNER, json!({"op":"repo_status"}))["version"], version);
}

#[test]
fn a_full_published_head_sends_a_commit_to_the_authority_which_refuses_it() {
    let (h, _) = open();
    let head = h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    );
    assert_eq!(head["full"], false);
    let begin = |head: &Value| {
        platform_compute(json!({"op":"head_begin","head":head,"paths":["x.txt"],
            "credentials":credentials(OWNER)}))
    };
    assert!(begin(&head).is_ok());
    let full = h.ok(
        "platform:projection",
        at_limit(json!({"op":"repo_head","ref":"main"})),
    );
    assert_eq!(full["full"], true);
    assert_eq!(begin(&full).unwrap_err().code, "REPO_FULL");
}

#[test]
fn work_already_accepted_keeps_going_at_the_limit() {
    let (h, _) = open();
    let a = h.shard_commit(AGENT, "a.txt", "a\n", json!([]));
    assert_eq!(outcome(&h.submit(vec![(OWNER, &a)]), 0).0, "landed");
    let adopted = h.run(
        "platform:commits",
        at_limit(json!({"op":"repo_adopt_commit","record":a})),
    );
    assert_eq!(code(adopted), "OK");
    // Everything below reads or settles: none may answer REPO_FULL.
    for (principal, command) in [
        (
            "platform:projection",
            json!({"op":"repo_projection_pending"}),
        ),
        (OWNER, json!({"op":"repo_compact_plan"})),
        ("platform:hooks", json!({"op":"repo_hooks_fanout"})),
        (OWNER, json!({"op":"repo_token_revoke","name":"ci"})),
    ] {
        assert_ne!(
            code(h.run(principal, at_limit(command.clone()))),
            "REPO_FULL",
            "{command}"
        );
    }
}
