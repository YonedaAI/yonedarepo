//! Repository memories: writers add them against a recorded commit with anchors, readers
//! list and rank them, a private repository hides them from non-members, credentials in
//! the text are refused, anchors go stale when the anchored file or symbol changes on main
//! (and not when another symbol in the file does), reads at a log version see what existed
//! then, the ranking is ordered as documented, deliveries are deduplicated per session, and
//! the tables arrive by a forward-only migration.
use super::*;
use crate::storage::SqlStore;

const READER: &str = "token:reader";
const LIB_V1: &str = "pub fn a() { 1 }\npub fn b() {}\n";
const LIB_V2: &str = "pub fn a() { 1 }\npub fn b() { 2 }\n";

fn blob(text: &str) -> String {
    hash_object(ObjectKind::Blob, text.as_bytes()).hex()
}

fn memory(commit: &str, kind: &str, text: &str, anchors: Value) -> Value {
    json!({"op":"repo_memory_add","commit":commit,"kind":kind,"text":text,"anchors":anchors})
}

fn lib_anchor(symbol: Option<&str>) -> Value {
    json!({"path":"src/lib.rs","symbol_path":symbol,"blob":blob(LIB_V1),
           "node_digest": symbol.map(|_| "d".repeat(64))})
}

/// main: the imported root (v1), then `LIB_V1` landed (v2). Returns the harness, the root
/// and the landed commit.
fn landed() -> (Harness, String, String) {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"reader","scopes":["read"],
               "_secret":"reader-secret-0123456789abcdef0123456789"}),
    );
    let first = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", LIB_V1)]),
            json!([]),
        )
        .unwrap();
    h.approve_and_check(&first);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":first}))["version"],
        2
    );
    (h, root, first)
}

/// Lands `LIB_V2` (only `b` changes, as the deriver records) on main at v3.
fn change_b(h: &Harness, parent: &str) -> String {
    let second = h
        .commit(
            AGENT,
            Some(parent),
            2,
            json!([file("src/lib.rs", LIB_V2)]),
            json!([]),
        )
        .unwrap();
    h.ok(
        "platform:derive",
        json!({"op":"repo_record_symbols","commit":second,"touches":[{"path":"src/lib.rs","symbols":["b"]}]}),
    );
    h.approve_and_check(&second);
    assert_eq!(
        h.ok(
            OWNER,
            json!({"op":"repo_land","ref":"main","commit":second})
        )["version"],
        3
    );
    second
}

fn shown(h: &Harness, id: &Value, extra: Value) -> Value {
    let mut c = json!({"op":"repo_memory_show","id":id});
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    h.ok(READER, c)["memory"].clone()
}

#[test]
fn writers_add_readers_read_and_strangers_are_not_told_it_exists() {
    let (h, _, first) = landed();
    let added = h.ok(
        AGENT,
        memory(
            &first,
            "gotcha",
            "retry() must stay idempotent: the land queue replays it.",
            json!([lib_anchor(Some("a"))]),
        ),
    );
    let id = added["memory"].clone();
    // The same memory again answers the first; a reader may not write.
    let again = h.ok(
        AGENT,
        memory(
            &first,
            "gotcha",
            "retry() must stay idempotent: the land queue replays it.",
            json!([lib_anchor(Some("a"))]),
        ),
    );
    assert_eq!(
        (again["memory"].clone(), again["already"].clone()),
        (id.clone(), json!(true))
    );
    let reader_add = memory(&first, "howto", "x", json!([]));
    assert_eq!(code(h.run(READER, reader_add)), "FORBIDDEN");
    // Readers list, show and rank it.
    let listed = h.ok(READER, json!({"op":"repo_memory_list"}));
    assert_eq!(listed["memories"][0]["id"], id);
    assert_eq!(listed["memories"][0]["author"], AGENT);
    assert_eq!(listed["memories"][0]["commit"], first);
    assert_eq!(listed["memories"][0]["status"], "active");
    let one = shown(&h, &id, json!({}));
    assert_eq!(one["anchors"][0]["symbol_path"], "a");
    assert_eq!(one["stale"], false);
    // A private repository answers NOT_FOUND to an account that is not a member, for every
    // memory op, read or write.
    for op in [
        json!({"op":"repo_memory_list"}),
        json!({"op":"repo_memory_show","id":id}),
        json!({"op":"repo_context_relevant","paths":["src/lib.rs"]}),
        json!({"op":"repo_context_deliveries","session_id":"claude-code:s1"}),
        memory(&first, "howto", "x", json!([])),
    ] {
        assert_eq!(
            code(h.run("member:stranger", op.clone())),
            "NOT_FOUND",
            "{op}"
        );
    }
    // Memories describe the whole repository: a path-restricted token uses none of them.
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run("token:docs", json!({"op":"repo_memory_list"}))),
        "FORBIDDEN"
    );
    // A public repository lets anyone read them, never write.
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    assert_eq!(
        h.ok("member:stranger", json!({"op":"repo_memory_list"}))["memories"][0]["id"],
        id
    );
    assert_eq!(
        code(h.run("member:stranger", memory(&first, "howto", "x", json!([])))),
        "FORBIDDEN"
    );
}

#[test]
fn text_is_bounded_validated_and_never_holds_a_credential() {
    let (h, _, first) = landed();
    let fake = ["sk-ant-", "api03-"].concat() + &"Ab1".repeat(31);
    let leaked = h.run(
        AGENT,
        memory(
            &first,
            "howto",
            &format!("Use {fake} for the eval."),
            json!([]),
        ),
    );
    assert_eq!(code(leaked.clone()), "SECRET_DETECTED");
    assert!(!leaked.unwrap_err().message.contains(&fake));
    for bad in [
        memory(&first, "howto", &"x".repeat(2049), json!([])),
        memory(&first, "howto", "  ", json!([])),
        memory(&first, "opinion", "x", json!([])),
        memory(&first, "howto", "x", json!([{"path":"../etc/passwd"}])),
        memory(
            &first,
            "howto",
            "x",
            json!([{"path":"src/","symbol_path":"a"}]),
        ),
        memory(
            &first,
            "howto",
            "x",
            json!([{"path":"src/lib.rs","blob":"zz"}]),
        ),
        memory(
            &first,
            "howto",
            "x",
            json!(
                (0..21)
                    .map(|n| json!({"path": format!("f{n}.rs")}))
                    .collect::<Vec<_>>()
            ),
        ),
    ] {
        let got = code(h.run(AGENT, bad.clone()));
        assert!(
            got == "INVALID_INPUT" || got == "UNSAFE_PATH",
            "{bad}: {got}"
        );
    }
    assert_eq!(
        code(h.run(AGENT, memory(&"e".repeat(40), "howto", "x", json!([])))),
        "NOT_FOUND"
    );
    // Nothing above was kept.
    assert!(
        h.ok(READER, json!({"op":"repo_memory_list"}))["memories"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn anchors_go_stale_when_the_anchored_code_changes_and_old_versions_do_not_see_later_ones() {
    let (h, _, first) = landed();
    let id = |c: Value| h.ok(AGENT, c)["memory"].clone();
    let on_file = id(memory(
        &first,
        "constraint",
        "lib.rs is generated",
        json!([lib_anchor(None)]),
    ));
    let on_a = id(memory(
        &first,
        "gotcha",
        "a() returns 1",
        json!([lib_anchor(Some("a"))]),
    ));
    let on_b = id(memory(
        &first,
        "gotcha",
        "b() is a stub",
        json!([lib_anchor(Some("b"))]),
    ));
    let on_dir = id(memory(
        &first,
        "decision",
        "src/ holds the library",
        json!([{"path":"src/"}]),
    ));
    for memory in [&on_file, &on_a, &on_b] {
        assert_eq!(shown(&h, memory, json!({}))["stale"], false);
    }
    assert!(shown(&h, &on_dir, json!({}))["stale"].is_null());
    change_b(&h, &first);
    // The file changed; only the symbol that changed is stale.
    assert_eq!(shown(&h, &on_file, json!({}))["stale"], true);
    assert_eq!(shown(&h, &on_b, json!({}))["stale"], true);
    assert_eq!(shown(&h, &on_b, json!({}))["anchors"][0]["stale"], true);
    assert_eq!(shown(&h, &on_a, json!({}))["stale"], false);
    // As of version 2 nothing had changed yet.
    assert_eq!(shown(&h, &on_b, json!({"at":2}))["stale"], false);
    let stale = h.ok(READER, json!({"op":"repo_memory_list","status":"stale"}));
    let ids: Vec<&Value> = stale["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| &m["id"])
        .collect();
    assert_eq!(ids, [&on_b, &on_file]);
    // A memory added now does not exist at version 2; a retirement now is not seen there.
    let later = id(memory(&first, "howto", "run the unit check", json!([])));
    h.ok(
        AGENT,
        json!({"op":"repo_memory_retire","id":on_file,"reason":"no longer generated"}),
    );
    let at_two = h.ok(
        READER,
        json!({"op":"repo_memory_list","at":2,"status":"all"}),
    );
    let ids: Vec<&Value> = at_two["memories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| &m["id"])
        .collect();
    assert_eq!(ids, [&on_dir, &on_b, &on_a, &on_file]);
    assert_eq!(at_two["memories"][3]["status"], "active");
    // At version 3 (the latest) the retirement shows, with who did it and why.
    let now = shown(&h, &on_file, json!({}));
    assert_eq!(now["status"], "retired");
    assert_eq!(now["retired"]["by"], AGENT);
    assert_eq!(now["retired"]["reason"], "no longer generated");
    assert!(code(h.run(READER, json!({"op":"repo_memory_show","id":later,"at":2}))) == "NOT_FOUND");
    assert_eq!(
        code(h.run(READER, json!({"op":"repo_memory_list","at":99}))),
        "INVALID_INPUT"
    );
}

#[test]
fn superseding_and_drafts_change_what_is_current() {
    let (h, _, first) = landed();
    let old = h.ok(AGENT, memory(&first, "howto", "run make test", json!([])))["memory"].clone();
    let mut newer = memory(&first, "howto", "run cargo xtask check", json!([]));
    newer["supersedes"] = old.clone();
    let new = h.ok(AGENT, newer.clone())["memory"].clone();
    assert_eq!(shown(&h, &old, json!({}))["status"], "superseded");
    assert_eq!(shown(&h, &old, json!({}))["superseded_by"], new);
    // A superseded memory cannot be superseded again.
    newer["text"] = json!("again");
    assert_eq!(code(h.run(AGENT, newer)), "CONFLICT");
    // A draft is listed as a draft, never ranked; publishing supersedes it.
    let mut draft = memory(&first, "decision", "Chose retries over queues.", json!([]));
    draft["draft"] = json!(true);
    draft["session_id"] = json!("claude-code:s1");
    let draft_id = h.ok(AGENT, draft)["memory"].clone();
    let drafts = h.ok(READER, json!({"op":"repo_memory_list","status":"draft"}));
    assert_eq!(drafts["memories"][0]["id"], draft_id);
    let ranked = h.ok(
        READER,
        json!({"op":"repo_context_relevant","query":"retries queues","fill":true}),
    );
    assert!(
        ranked["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|i| i["id"] != draft_id)
    );
    let mut publish = memory(
        &first,
        "decision",
        "Chose retries over queues (simpler).",
        json!([]),
    );
    publish["supersedes"] = draft_id.clone();
    h.ok(OWNER, publish);
    assert_eq!(shown(&h, &draft_id, json!({}))["status"], "superseded");
    let current = h.ok(READER, json!({"op":"repo_memory_list"}));
    assert_eq!(current["memories"].as_array().unwrap().len(), 2);
}

#[test]
fn ranking_orders_by_place_then_text_then_freshness_then_recency() {
    let (h, _, first) = landed();
    let add = |text: &str, anchors: Value| {
        h.ok(AGENT, memory(&first, "gotcha", text, anchors))["memory"]
            .as_i64()
            .unwrap()
    };
    let dir = add(
        "Everything in src is the library.",
        json!([{"path":"src/"}]),
    );
    let file_old = add(
        "lib.rs keeps one function per symbol.",
        json!([lib_anchor(None)]),
    );
    let symbol = add("a() returns one.", json!([lib_anchor(Some("a"))]));
    let file_new = add("lib.rs is formatted by rustfmt.", json!([lib_anchor(None)]));
    let text_only = add("The retry budget is three attempts.", json!([]));
    let elsewhere = add(
        "README is user facing.",
        json!([{"path":"README.md","blob":blob("# demo\n")}]),
    );
    let ranked = |c: Value| -> Vec<i64> {
        let mut c = c;
        c["op"] = json!("repo_context_relevant");
        c["types"] = json!(["memory"]);
        h.ok(READER, c)["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_i64().unwrap())
            .collect()
    };
    // Symbol 8, file 4 (newest first), directory 2; unrelated memories are left out.
    assert_eq!(
        ranked(json!({"symbols":["src/lib.rs#a"]})),
        [symbol, file_new, file_old, dir]
    );
    // Each query term adds 2: rustfmt lifts one file memory, and two terms place a memory
    // without anchors with the file's (newest first among them).
    assert_eq!(
        ranked(json!({"paths":["src/lib.rs"],"query":"What is the retry budget for rustfmt?"})),
        [file_new, text_only, symbol, file_old, dir]
    );
    // Same score: fresh before stale, then newest first.
    assert_eq!(
        ranked(json!({"paths":["src/lib.rs"]})),
        [file_new, symbol, file_old, dir]
    );
    change_b(&h, &first);
    assert_eq!(
        ranked(json!({"paths":["src/lib.rs"]})),
        [symbol, file_new, file_old, dir]
    );
    // fill adds the newest current memories after the matches (a session start).
    let start = ranked(json!({"paths":["src/lib.rs"],"fill":true,"limit":50}));
    assert_eq!(&start[4..], [elsewhere, text_only]);
    // Deterministic: the same request answers the same order.
    assert_eq!(
        start,
        ranked(json!({"paths":["src/lib.rs"],"fill":true,"limit":50}))
    );
}

#[test]
fn ranking_includes_contracts_sessions_and_changes_by_place_and_text() {
    let (h, root, first) = landed();
    h.ok(
        AGENT,
        json!({"op":"repo_session_record","commit":first,"cli":"claude-code",
               "summary":"Made a() return one and added the retry budget."}),
    );
    let fix = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/retry.md", "budget\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":fix,"expected":null}]}),
    );
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Document the retry budget"}),
    );
    h.db.query(
        "INSERT INTO symbol_contracts(path,symbol_path,commit_id,node_digest,contract,contract_digest,recorded_by,recorded_at,recorded_version) VALUES('src/lib.rs','a',?,?,'{\"summary\":\"Returns one.\"}',?,?,1,2)",
        &[json!(first), json!("d".repeat(64)), json!("c".repeat(64)), json!(AGENT)],
    )
    .unwrap();
    let got = h.ok(
        READER,
        json!({"op":"repo_context_relevant","paths":["src/lib.rs"],"query":"retry budget"}),
    );
    let order: Vec<(String, u64)> = got["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["type"].as_str().unwrap().to_owned(),
                i["score"].as_u64().unwrap(),
            )
        })
        .collect();
    // The session changed lib.rs and its summary names both terms (4 + 4); the contract is
    // on lib.rs (4); the change names both terms (4) and is newer than the contract.
    assert_eq!(
        order,
        [
            ("session".to_owned(), 8),
            ("change".to_owned(), 4),
            ("contract".to_owned(), 4)
        ]
    );
    assert_eq!(got["items"][1]["change"]["number"], 1);
    assert_eq!(got["items"][2]["contract"]["symbol_path"], "a");
    assert_eq!(got["terms"], json!(["retry", "budget"]));
    // The agent context at session start carries memories ranked for its paths.
    h.ok(
        AGENT,
        memory(
            &first,
            "howto",
            "Run the unit check before landing.",
            json!([]),
        ),
    );
    let context = h.ok(
        READER,
        json!({"op":"repo_agent_context","paths":["src/lib.rs"]}),
    );
    assert_eq!(
        context["memories"][0]["memory"]["text"],
        "Run the unit check before landing."
    );
}

#[test]
fn deliveries_are_recorded_per_session_and_left_out_of_later_rankings() {
    let (h, _, first) = landed();
    let a = h.ok(
        AGENT,
        memory(
            &first,
            "gotcha",
            "a() returns one.",
            json!([lib_anchor(Some("a"))]),
        ),
    )["memory"]
        .clone();
    let b = h.ok(
        AGENT,
        memory(
            &first,
            "gotcha",
            "b() is a stub.",
            json!([lib_anchor(Some("b"))]),
        ),
    )["memory"]
        .clone();
    let relevant = |principal: &str, session: &str| {
        h.ok(
            principal,
            json!({"op":"repo_context_relevant","paths":["src/lib.rs"],"types":["memory"],"session_id":session}),
        )
    };
    let first_read = relevant(AGENT, "claude-code:s1");
    assert_eq!(first_read["items"].as_array().unwrap().len(), 2);
    assert_eq!(first_read["delivered"], json!({"bytes":0,"count":0}));
    h.ok(
        AGENT,
        json!({"op":"repo_context_deliver","session_id":"claude-code:s1","trigger":"read",
               "subject":"src/lib.rs","items":[{"type":"memory","id":a}],"bytes":120}),
    );
    let second_read = relevant(AGENT, "claude-code:s1");
    assert_eq!(second_read["items"].as_array().unwrap().len(), 1);
    assert_eq!(second_read["items"][0]["id"], b);
    assert_eq!(second_read["delivered"], json!({"bytes":120,"count":1}));
    // Another session, or another caller in the same session, starts afresh.
    assert_eq!(
        relevant(AGENT, "claude-code:s2")["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        relevant(OWNER, "claude-code:s1")["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // The session page reads what was shown, labelled.
    let shown = h.ok(
        READER,
        json!({"op":"repo_context_deliveries","session_id":"claude-code:s1"}),
    );
    assert_eq!(shown["deliveries"][0]["trigger"], "read");
    assert_eq!(
        shown["deliveries"][0]["items"][0]["label"],
        "gotcha: a() returns one."
    );
    assert_eq!(shown["bytes"], 120);
    // Readers do not record deliveries; a prompt is kept only as its digest.
    let prompt = json!({"op":"repo_context_deliver","session_id":"claude-code:s1","trigger":"prompt",
                        "subject":"fix the retry","items":[],"bytes":0});
    assert_eq!(code(h.run(READER, prompt.clone())), "FORBIDDEN");
    assert_eq!(code(h.run(AGENT, prompt)), "INVALID_INPUT");
    h.ok(
        AGENT,
        json!({"op":"repo_context_deliver","session_id":"claude-code:s1","trigger":"prompt",
               "subject":"f".repeat(64),"items":[{"type":"change","id":7}],"bytes":10}),
    );
}

#[test]
fn the_memory_tables_arrive_by_a_repeatable_forward_migration() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations
        .iter()
        .position(|(version, _)| *version == 39)
        .unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO repo_settings(id,name,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','demo','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    assert!(db.query("SELECT id FROM memories", &[]).is_err());
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(db.query("SELECT id FROM memories", &[]).unwrap().is_empty());
    assert!(
        db.query("SELECT seq FROM context_deliveries", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT name FROM repo_settings", &[]).unwrap()[0]["name"],
        "demo"
    );
    // The kind and trigger columns refuse anything else; full-text search works.
    assert!(db.query("INSERT INTO memories(kind,body,commit_id,author,recorded_at,recorded_version) VALUES('opinion','x','c','a',1,1)", &[]).is_err());
    db.query(
        "INSERT INTO memory_text(rowid,body) VALUES(1,'Retry budget')",
        &[],
    )
    .unwrap();
    assert_eq!(
        db.query(
            "SELECT rowid AS id FROM memory_text WHERE memory_text MATCH '\"retry\"'",
            &[]
        )
        .unwrap()[0]["id"],
        1
    );
}
