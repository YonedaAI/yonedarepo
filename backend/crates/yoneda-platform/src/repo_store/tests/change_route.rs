//! A change's route: one bounded read of the commits it introduces, the sessions behind
//! them, what those sessions were shown and the checks on them. The range agrees with the
//! change's diff, open or landed; a path-restricted token reads none of it; quarantine masks
//! it as it masks the session and memory reads; every list has a cap that says when it cut.
use super::*;
use crate::storage::SqlStore;

const SESSION: &str = "claude-code:s1";

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

fn open(h: &Harness, branch: &str) -> Value {
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":branch,"title":"Retry"}),
    )
}

fn record(h: &Harness, commit: &str, session: &str, read: u64, fetched: u64) -> Value {
    h.ok(
        AGENT,
        json!({"op":"repo_session_record","commit":commit,"cli":"claude-code","model":"opus",
               "summary":format!("worked on {}", &commit[..6]),"session_id":session,
               "read_bytes":read,"fetched_bytes":fetched}),
    )["session"]
        .clone()
}

fn memory(h: &Harness, commit: &str, text: &str, session: Option<&str>) -> Value {
    h.ok(
        AGENT,
        json!({"op":"repo_memory_add","commit":commit,"kind":"gotcha","text":text,"anchors":[],
               "session_id":session}),
    )["memory"]
        .clone()
}

fn deliver(h: &Harness, session: &str, memory: &Value, bytes: u64) {
    h.ok(
        AGENT,
        json!({"op":"repo_context_deliver","session_id":session,"trigger":"read",
               "subject":"src/lib.rs","items":[{"type":"memory","id":memory}],"bytes":bytes}),
    );
}

fn route(h: &Harness, who: &str, number: i64) -> Value {
    h.ok(who, json!({"op":"repo_change_route","number":number}))
}

fn commits(route: &Value) -> Vec<&str> {
    let listed = route["commits"].as_array().unwrap();
    listed
        .iter()
        .map(|c| c["commit"].as_str().unwrap())
        .collect()
}

#[test]
fn a_route_holds_one_changes_commits_sessions_context_and_checks() {
    let (h, root) = seeded();
    let first = push(&h, "fix", &root, "src/retry.rs");
    let second = push(&h, "fix", &first, "src/backoff.rs");
    let other = push(&h, "other", &root, "other.txt");
    open(&h, "fix");
    // main moves on: what it gained is not the change's, and neither is `root`.
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
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":docs}));

    // One coding session across two commits: its tally is cumulative, never added up.
    let early = record(&h, &first, SESSION, 100, 400);
    let late = record(&h, &second, SESSION, 250, 500);
    let brief = record(&h, &second, "opencode:s2", 10, 20);
    record(&h, &other, "opencode:s3", 9_000, 9_000);
    let used = memory(&h, &root, "Backoff caps at 30s.", None);
    deliver(&h, SESSION, &used, 300);
    deliver(&h, "opencode:s2", &used, 40);
    deliver(&h, "opencode:s3", &used, 9_000);
    for commit in [&root, &second] {
        let check = json!({"op":"repo_check","commit":commit,"name":"unit","status":"pass"});
        h.ok(CI, check);
    }

    let shown = route(&h, CI, 1);
    assert_eq!(
        (
            &shown["number"],
            &shown["status"],
            &shown["branch"],
            &shown["base"]
        ),
        (&json!(1), &json!("open"), &json!("fix"), &json!("main"))
    );
    assert_eq!(shown["head"], json!(second));
    assert_eq!(shown["merge_base"], json!(root));
    assert_eq!(commits(&shown), [second.as_str(), first.as_str()]);
    let newest = &shown["commits"][0];
    assert_eq!(newest["subject"], "change");
    assert_eq!(newest["principal"], AGENT);
    assert_eq!(newest["parents"], json!([first]));
    assert!(newest["at"].as_i64().unwrap() > 0);

    let sessions = shown["sessions"].as_array().unwrap();
    let ids: Vec<&Value> = sessions.iter().map(|s| &s["id"]).collect();
    assert_eq!(ids, [&brief, &late, &early]);
    assert_eq!(sessions[1]["commit"], json!(second));
    assert_eq!(sessions[1]["cli"], "claude-code");
    assert_eq!(sessions[1]["model"], "opus");
    assert_eq!(sessions[1]["session_id"], SESSION);
    assert_eq!(sessions[1]["read_bytes"], 250);
    assert_eq!(sessions[1]["fetched_bytes"], 500);
    assert_eq!(sessions[1]["quarantined"], false);

    let delivered = shown["deliveries"].as_array().unwrap();
    assert_eq!(delivered.len(), 2, "{delivered:?}");
    assert_eq!(delivered[0]["session_id"], SESSION);
    assert_eq!(delivered[0]["trigger"], "read");
    assert_eq!(delivered[0]["subject"], "src/lib.rs");
    assert_eq!(delivered[0]["bytes"], 300);
    assert_eq!(delivered[0]["items"][0]["type"], "memory");
    assert_eq!(delivered[0]["items"][0]["id"], used);
    assert_eq!(
        delivered[0]["items"][0]["label"],
        "gotcha: Backoff caps at 30s."
    );

    let checks = shown["checks"].as_array().unwrap();
    assert_eq!(checks.len(), 1, "{checks:?}");
    assert_eq!(checks[0]["commit"], json!(second));
    assert_eq!(checks[0]["name"], "unit");
    assert_eq!(checks[0]["status"], "pass");
    assert_eq!(checks[0]["principal"], CI);

    assert_eq!(
        shown["totals"],
        json!({"commits":2,"sessions":2,"read_bytes":260,"fetched_bytes":520,
               "delivered_bytes":340,"memories_delivered":1})
    );
    assert_eq!(
        shown["truncated"],
        json!({"commits":false,"sessions":false,"deliveries":false,"checks":false})
    );
}

#[test]
fn a_landed_change_keeps_its_route_against_the_base_before_it_landed() {
    let (h, root) = seeded();
    let fast = push(&h, "fast", &root, "fast.txt");
    let merged = push(&h, "merged", &root, "merged.txt");
    open(&h, "fast");
    open(&h, "merged");
    h.approve_and_check(&fast);
    h.approve_and_check(&merged);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":fast}));
    // On main now, and still what the change introduced.
    let landed = route(&h, CI, 1);
    assert_eq!(landed["status"], "landed");
    assert_eq!(commits(&landed), [fast.as_str()]);
    assert_eq!(landed["merge_base"], json!(root));

    // A platform merge lands the second on the moved main.
    let version = h.ok(OWNER, json!({"op":"repo_refs"}))["version"]
        .as_u64()
        .unwrap();
    let blob = hash_object(ObjectKind::Blob, b"x\n");
    let merge = h
        .commit_with(
            "platform:merge",
            Some(&fast),
            version,
            json!([{"path":"merged.txt","blob":blob,"type":"blob"}]),
            json!([]),
            json!({"merge_parent": merged}),
        )
        .unwrap();
    h.ok(
        OWNER,
        json!({"op":"repo_land","ref":"main","commit":merged,"merge":merge}),
    );
    let landed = route(&h, CI, 2);
    assert_eq!(landed["status"], "landed");
    assert_eq!(commits(&landed), [merged.as_str()]);
    assert_eq!(landed["merge_base"], json!(root));
    // Its branch is gone and main moves on: the route stands.
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"merged","commit":null,"expected":merged}]}),
    );
    let later = h.commit(
        AGENT,
        Some(&merge),
        version + 1,
        json!([file("later.txt", "l\n")]),
        json!([]),
    );
    let later = later.unwrap();
    h.approve_and_check(&later);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":later}));
    assert_eq!(commits(&route(&h, CI, 2)), [merged.as_str()]);
}

#[test]
fn a_branch_gone_leaves_an_empty_route_and_an_unknown_change_is_refused() {
    let (h, root) = seeded();
    let head = push(&h, "fix", &root, "fix.txt");
    open(&h, "fix");
    h.ok(AGENT, json!({"op":"repo_change_close","number":1}));
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":null,"expected":head}]}),
    );
    let gone = route(&h, CI, 1);
    assert_eq!(gone["head"], Value::Null);
    assert_eq!(gone["merge_base"], Value::Null);
    assert_eq!(gone["commits"], json!([]));
    assert_eq!(gone["sessions"], json!([]));
    let missing = json!({"op":"repo_change_route","number":9});
    assert_eq!(code(h.run(CI, missing)), "NOT_FOUND");
    let invalid = json!({"op":"repo_change_route","number":0});
    assert_eq!(code(h.run(CI, invalid)), "INVALID_INPUT");
}

#[test]
fn a_path_restricted_token_reads_no_route_and_a_public_reader_reads_what_the_page_shows() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
               "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    let head = push(&h, "fix", &root, "src/hidden.rs");
    open(&h, "fix");
    record(&h, &head, SESSION, 1, 1);
    let show = json!({"op":"repo_change_show","number":1});
    assert_eq!(code(h.run("token:docs", show)), "FORBIDDEN");
    let refused = h.run("token:docs", json!({"op":"repo_change_route","number":1}));
    assert_eq!(code(refused), "FORBIDDEN");

    let anonymous = json!({"op":"repo_change_route","number":1,"_anonymous":true});
    let hidden = execute_repo_store(&h.db, anonymous.clone());
    assert_eq!(code(hidden), "NOT_FOUND");
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    let read = execute_repo_store(&h.db, anonymous).unwrap();
    assert_eq!(commits(&read), [head.as_str()]);
}

#[test]
fn quarantine_masks_the_sessions_and_memories_on_a_route() {
    let (h, root) = seeded();
    let head = push(&h, "fix", &root, "fix.txt");
    open(&h, "fix");
    let session = h.ok(
        AGENT,
        json!({"op":"repo_session_record","commit":head,"cli":"claude-code",
               "summary":"pasted the staging password hunter2","session_id":SESSION,
               "transcript_ref":"hunter2-transcript"}),
    )["session"]
        .clone();
    let leaked = memory(&h, &head, "staging password is hunter2", Some(SESSION));
    let clean = memory(&h, &head, "retry budget lives in the gateway", None);
    for item in [&leaked, &clean] {
        deliver(&h, SESSION, item, 10);
    }
    let before = route(&h, CI, 1);
    assert!(before.to_string().contains("hunter2"));

    let record = h.ok(
        OWNER,
        json!({"op":"repo_quarantine","target":{"kind":"session","id":session.to_string()},
               "path":"src/lib.rs","reason":"a leaked credential"}),
    )["record"]["id"]
        .clone();
    let masked = route(&h, CI, 1);
    assert!(!masked.to_string().contains("hunter2"), "{masked}");
    let shown = &masked["sessions"][0];
    assert_eq!(
        (&shown["summary"], &shown["quarantined"]),
        (&Value::Null, &json!(true))
    );
    assert_eq!(masked["deliveries"][0]["items"][0]["label"], Value::Null);
    assert_eq!(
        masked["deliveries"][1]["items"][0]["label"],
        "gotcha: retry budget lives in the gateway"
    );

    h.ok(OWNER, json!({"op":"repo_quarantine_release","id":record}));
    assert!(route(&h, CI, 1).to_string().contains("hunter2"));
}

#[test]
fn every_list_on_a_route_has_a_cap_and_says_when_it_cut() {
    let (h, root) = seeded();
    let mut tip = root.clone();
    let mut heads = Vec::new();
    for n in 0..502 {
        tip = h
            .commit(
                AGENT,
                Some(&tip),
                1,
                json!([file("log.txt", &format!("{n}\n"))]),
                json!([]),
            )
            .unwrap();
        heads.push(tip.clone());
    }
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"long","commit":tip,"expected":null}),
    );
    open(&h, "long");
    for commit in heads.iter().rev().take(12) {
        for n in 0..20 {
            record(&h, commit, &format!("claude-code:s{n}"), 1, 1);
        }
    }
    for (n, commit) in heads.iter().enumerate() {
        h.db.query(
            "INSERT INTO context_deliveries(session_id,trigger,items,bytes,principal,at) \
             VALUES('claude-code:s0','start','[]',1,'token:agent',?)",
            &[json!(n)],
        )
        .unwrap();
        h.db.query(
            "INSERT INTO checks(commit_id,name,policy_digest,status,principal,recorded_at) \
             VALUES(?,'unit','p','pass','token:ci',?)",
            &[json!(commit), json!(n)],
        )
        .unwrap();
    }
    // The two oldest commits are past the cap, so one more check is what passes it.
    h.db.query(
        "INSERT INTO checks(commit_id,name,policy_digest,status,principal,recorded_at) \
         VALUES(?,'lint','p','pass','token:ci',999)",
        &[json!(tip)],
    )
    .unwrap();
    let long = route(&h, CI, 1);
    assert_eq!(long["commits"].as_array().unwrap().len(), 500);
    assert_eq!(long["sessions"].as_array().unwrap().len(), 200);
    assert_eq!(long["deliveries"].as_array().unwrap().len(), 500);
    assert_eq!(long["checks"].as_array().unwrap().len(), 500);
    assert_eq!(
        long["truncated"],
        json!({"commits":true,"sessions":true,"deliveries":true,"checks":true})
    );
    // Newest kept, in each list.
    assert_eq!(long["commits"][0]["commit"], json!(tip));
    assert_eq!(long["sessions"][0]["commit"], json!(heads[490]));
    assert_eq!(
        long["deliveries"].as_array().unwrap().last().unwrap()["at"],
        501
    );
    assert_eq!(long["checks"][0]["commit"], json!(tip));
}
