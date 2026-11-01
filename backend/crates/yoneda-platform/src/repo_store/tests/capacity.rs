//! What a repository's database holds (`repo_storage`, for its owner and the platform) and
//! the refusal of new work near the size limit, which leaves accepted work running.
use super::batches::{credentials, open, outcome};
use super::*;
use crate::platform_compute;
use crate::repo_store::capacity::{refusal, refuses, size_refusal};
use crate::repo_store::op::Op;
use crate::storage::SqlStore;

const MERGER: &str = "platform:merge";

fn tree_of(h: &Harness, commit: &str) -> String {
    h.ok(OWNER, json!({"op":"repo_commit","commit":commit}))["tree"]
        .as_str()
        .unwrap()
        .to_owned()
}

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
            "repo_change_create",
            "repo_flight_plan",
            "repo_import",
            "repo_memory_add",
            "repo_prepare_commit",
            "repo_record_commit",
            "repo_record_imported",
            "repo_record_imported_batch",
            "repo_record_pushed",
            "repo_release_create",
            "repo_session_record",
            "repo_tag_create",
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
fn a_refusal_says_what_to_do_in_plain_words() {
    let full = refusal().message;
    let large = size_refusal().message;
    for message in [&full, &large] {
        for words in ["reading", "deleting", "new repository", "support"] {
            assert!(message.contains(words), "{message}");
        }
        assert!(!message.contains("database"), "{message}");
    }
    // The history database's limit is internal: no number reaches anybody.
    assert!(full.contains("activity limit"), "{full}");
    assert!(!full.contains("GB"), "{full}");
    assert!(large.contains("10 GB"), "{large}");
    assert_eq!(full, yoneda_store::REPO_FULL_MESSAGE);
}

/// A repository with the size column, whichever wave this binary is in.
fn sized() -> (Harness, String) {
    let (h, root) = open();
    let all = &crate::repo_store::migration::MIGRATIONS;
    crate::repo_store::migration::migrate_with(&h.db, "repo_schema_migrations", all).unwrap();
    (h, root)
}

fn size_of(h: &Harness) -> Value {
    h.ok(OWNER, json!({"op":"repo_storage"}))["git_bytes"].clone()
}

/// `commit` recorded as a push of `pack_bytes`.
fn record(h: &Harness, commit: &Value, pack_bytes: u64) -> yoneda_core::Result<Value> {
    h.run(
        AGENT,
        json!({"op":"repo_record_pushed","commits":[commit],"pack_bytes":pack_bytes}),
    )
}

fn over(mut command: Value, limit: u64) -> Value {
    command["_size_guard"] = json!(limit);
    command
}

#[test]
fn a_push_adds_its_pack_to_the_repository_size_once() {
    let (h, root) = sized();
    assert_eq!(size_of(&h), json!(0));
    let (_, first) = super::pushed::pushed(&root, &tree_of(&h, &root), "one");
    record(&h, &first, 1_000).unwrap();
    assert_eq!(size_of(&h), json!(1_000));
    // A retried push records nothing new, and stores nothing new.
    record(&h, &first, 1_000).unwrap();
    assert_eq!(size_of(&h), json!(1_000));
}

#[test]
fn the_size_column_arrives_at_zero_from_the_preceding_schema_and_once() {
    use crate::repo_store::migration::{MIGRATIONS, migrate_with};
    let db = crate::native::NativeStore::memory().unwrap();
    let before = MIGRATIONS.iter().position(|(v, _)| *v == 46).unwrap();
    migrate_with(&db, "repo_schema_migrations", &MIGRATIONS[..before]).unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    migrate_with(&db, "repo_schema_migrations", &MIGRATIONS).unwrap();
    migrate_with(&db, "repo_schema_migrations", &MIGRATIONS).unwrap();
    let size = db
        .query("SELECT git_bytes FROM repo_settings", &[])
        .unwrap();
    assert_eq!(size[0]["git_bytes"], json!(0));
}

#[test]
fn only_the_platform_adds_what_api_commits_stored() {
    let (h, _) = sized();
    let add = json!({"op":"repo_size_add","pack_bytes":2_000_000});
    assert_eq!(code(h.run(OWNER, add.clone())), "FORBIDDEN");
    assert_eq!(code(h.run(AGENT, add.clone())), "FORBIDDEN");
    h.ok("platform:commits", add);
    assert_eq!(size_of(&h), json!(2_000_000));
}

#[test]
fn a_direct_import_adds_the_pack_it_fetched() {
    let h = Harness::new();
    let all = &crate::repo_store::migration::MIGRATIONS;
    crate::repo_store::migration::migrate_with(&h.db, "repo_schema_migrations", all).unwrap();
    let id = "1".repeat(40);
    h.ok(
        "platform:import",
        json!({"op":"repo_record_imported","commit":id,"tree":"2".repeat(40),"parents":[],
            "message":"head","touches":[]}),
    );
    h.ok(
        "platform:import",
        json!({"op":"repo_import","ref":"main","commit":id,"pack_bytes":24_000}),
    );
    assert_eq!(size_of(&h), json!(24_000));
}

#[test]
fn at_the_size_limit_pushes_and_new_commits_stop_and_nothing_else_does() {
    let (h, root) = sized();
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("x.txt", "x\n")]),
            json!([]),
        )
        .unwrap();
    let (_, pushed) = super::pushed::pushed(&root, &tree_of(&h, &root), "big");
    record(&h, &pushed, 5_000).unwrap();
    let push = json!({"op":"repo_git_access","service":"git-receive-pack"});
    let fetch = json!({"op":"repo_git_access","service":"git-upload-pack"});
    let prepare = json!({"op":"repo_prepare_commit","ref":"main","changes":[file("y", "y\n")]});
    let begin = json!({"op":"repo_begin_commit","ref":"main","paths":["y"]});
    for command in [&push, &prepare, &begin] {
        assert_eq!(
            code(h.run(AGENT, over(command.clone(), 5_000))),
            "REPO_SIZE_LIMIT",
            "{command}"
        );
        assert_ne!(
            code(h.run(AGENT, over(command.clone(), 5_001))),
            "REPO_SIZE_LIMIT",
            "{command}"
        );
    }
    h.ok(AGENT, over(fetch, 5_000));
    assert_eq!(h.ok(OWNER, over(land(&id), 5_000))["landed"], true);
}

/// A purge of the seeded file reporting `bytes` on a repository of 5,000: what it leaves.
fn after_purge(bytes: u64) -> Value {
    let (h, root) = sized();
    let (_, pushed) = super::pushed::pushed(&root, &tree_of(&h, &root), "big");
    record(&h, &pushed, 5_000).unwrap();
    let blob = yoneda_core::git_object::hash_object(ObjectKind::Blob, b"pub fn a() {}\n").hex();
    let record = h.ok(
        OWNER,
        json!({"op":"repo_quarantine","target":{"kind":"blob","id":blob},"path":"src/lib.rs",
            "reason":"too large"}),
    )["record"]["id"]
        .clone();
    let claimed = h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purge","id":record,"confirm":blob}),
    );
    let epoch = claimed["claims"][0]["epoch"].as_i64().unwrap();
    let report = |epoch: i64| {
        json!({"op":"repo_quarantine_purged","replacement":"platform:demo",
            "claims":[{"id":record,"epoch":epoch,"bytes":bytes}]})
    };
    // A report its lease has outlived changes nothing, and neither does a repeat.
    h.ok(OWNER, report(epoch - 1));
    assert_eq!(size_of(&h), json!(5_000));
    h.ok(OWNER, report(epoch));
    let left = size_of(&h);
    h.ok(OWNER, report(epoch));
    assert_eq!(size_of(&h), left);
    left
}

#[test]
fn a_purge_takes_its_file_off_the_size_once_and_never_below_nothing() {
    assert_eq!(after_purge(2_000), json!(3_000));
    assert_eq!(after_purge(9_000), json!(0));
}

#[test]
fn a_full_published_head_says_which_limit_it_reached() {
    let (h, root) = sized();
    let (_, pushed) = super::pushed::pushed(&root, &tree_of(&h, &root), "big");
    record(&h, &pushed, 5_000).unwrap();
    let head = h.ok(
        "platform:projection",
        over(json!({"op":"repo_head","ref":"main"}), 5_000),
    );
    assert_eq!(head["full"], false);
    assert_eq!(head["over_size"], true);
    let begun = platform_compute(json!({"op":"head_begin","head":head,"paths":["x.txt"],
        "credentials":credentials(OWNER)}));
    assert_eq!(begun.unwrap_err().code, "REPO_SIZE_LIMIT");
}

#[test]
fn a_schema_without_the_size_column_counts_nothing_and_refuses_nothing() {
    let (h, root) = open();
    let (_, pushed) = super::pushed::pushed(&root, &tree_of(&h, &root), "big");
    h.db.query("ALTER TABLE repo_settings DROP COLUMN git_bytes", &[])
        .ok();
    record(&h, &pushed, 5_000).unwrap();
    assert_eq!(size_of(&h), Value::Null);
    let push = json!({"op":"repo_git_access","service":"git-receive-pack"});
    h.ok(AGENT, over(push, 1));
}

#[test]
fn a_new_branch_is_refused_and_a_move_or_a_delete_is_not() {
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
    let set = |name: &str, commit: &str, expected: Value| json!({"op":"repo_branch_set","ref":name,"commit":commit,"expected":expected});
    let batch = |updates: Value| json!({"op":"repo_branch_batch","updates":updates});
    h.ok(AGENT, set("topic", &root, Value::Null));
    h.ok(AGENT, set("old", &root, Value::Null));
    assert_eq!(
        code(h.run(AGENT, at_limit(set("new", &root, Value::Null)))),
        "REPO_FULL"
    );
    let created = batch(json!([
        {"ref":"topic","commit":id,"expected":root},
        {"ref":"new","commit":root,"expected":null},
    ]));
    assert_eq!(code(h.run(AGENT, at_limit(created))), "REPO_FULL");
    let tagged = batch(json!([{"ref":"refs/tags/v1","commit":root,"expected":null}]));
    assert_eq!(code(h.run(OWNER, at_limit(tagged))), "REPO_FULL");
    // Nothing above moved, so the expected values still hold.
    h.ok(AGENT, at_limit(set("topic", &id, json!(root))));
    let gone = batch(json!([{"ref":"old","commit":null,"expected":root}]));
    h.ok(AGENT, at_limit(gone));
    let refs = h.ok(AGENT, json!({"op":"repo_refs"}));
    assert_eq!(refs["refs"]["refs/heads/topic"], json!(id));
    assert!(refs["refs"]["refs/heads/old"].is_null());
    assert!(refs["refs"]["refs/heads/new"].is_null());
}

#[test]
fn a_new_comment_is_refused_and_resolving_one_is_not() {
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
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":id,"expected":null}),
    );
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Fix"}),
    );
    let anchored = json!({"op":"repo_change_comment","number":1,"body":"nit","commit":id,
        "path":"x.txt","line":1,"side":"new"});
    h.ok(OWNER, anchored.clone());
    assert_eq!(code(h.run(OWNER, at_limit(anchored.clone()))), "REPO_FULL");
    let mut resolved = anchored;
    resolved.as_object_mut().unwrap().remove("body");
    resolved["resolve"] = json!(true);
    h.ok(OWNER, at_limit(resolved));
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
