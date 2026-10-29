//! Session records: posted by the commit's pusher (or the owner) with write, listed in
//! arrival order, refused when the summary holds a credential, idempotent on repeat,
//! bounded per commit, and closed to path-restricted tokens. The table arrives by an
//! additive migration that a second run leaves as it is.
use super::*;

fn session(commit: &str, summary: &str) -> Value {
    json!({ "op": "repo_session_record", "commit": commit, "cli": "claude-code",
            "model": "claude-sonnet-5-5", "summary": summary,
            "prompt_digest": "a".repeat(64), "read_set_digest": "b".repeat(64),
            "transcript_ref": "claude-code:3f2a" })
}

#[test]
fn sessions_are_posted_by_the_pusher_and_listed_per_commit() {
    let (h, root) = seeded();
    let mine = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn b() {}\n")]),
            json!([]),
        )
        .unwrap();
    // The pusher records it; a repeat answers the same record.
    let first = h.ok(AGENT, session(&mine, "Renamed a() to b()."));
    let again = h.ok(AGENT, session(&mine, "Renamed a() to b()."));
    assert_eq!(again["session"], first["session"]);
    assert_eq!(again["already"], true);
    // The owner may add one; a check-only token may not write, and another writer is not
    // the pusher.
    h.ok(OWNER, session(&mine, "Reviewed and kept."));
    assert_eq!(code(h.run(CI, session(&mine, "x"))), "FORBIDDEN");
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"other","scopes":["read","write"],
        "_secret":"other-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run("token:other", session(&mine, "not mine"))),
        "FORBIDDEN"
    );
    // Credentials never enter a record (the fake key is assembled at runtime).
    let fake = ["sk-ant-", "api03-"].concat() + &"Ab1".repeat(31);
    let leaked = h.run(AGENT, session(&mine, &format!("used {fake} to test")));
    assert_eq!(code(leaked.clone()), "SECRET_DETECTED");
    assert!(!leaked.unwrap_err().message.contains(&fake));
    // Bounded and validated fields.
    let mut long = session(&mine, &"x".repeat(4097));
    assert_eq!(code(h.run(AGENT, long.clone())), "INVALID_INPUT");
    long["summary"] = json!("ok");
    long["prompt_digest"] = json!("not-a-digest");
    assert_eq!(code(h.run(AGENT, long.clone())), "INVALID_INPUT");
    long["prompt_digest"] = Value::Null;
    long["cli"] = json!("claude code");
    assert_eq!(code(h.run(AGENT, long)), "INVALID_INPUT");
    assert_eq!(
        code(h.run(AGENT, session(&"e".repeat(40), "unknown"))),
        "NOT_FOUND"
    );

    let listed = h.ok(CI, json!({"op":"repo_sessions","commit":mine}));
    let sessions = listed["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["summary"], "Renamed a() to b().");
    assert_eq!(sessions[0]["recorded_by"], AGENT);
    assert_eq!(sessions[0]["model"], "claude-sonnet-5-5");
    assert_eq!(sessions[1]["recorded_by"], OWNER);
    for n in 2..20 {
        h.ok(AGENT, session(&mine, &format!("round {n}")));
    }
    assert_eq!(
        code(h.run(AGENT, session(&mine, "one too many"))),
        "TOO_LARGE"
    );

    // A path-restricted token reads neither.
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run("token:docs", json!({"op":"repo_sessions","commit":mine}))),
        "FORBIDDEN"
    );
    // Migrating again changes nothing.
    crate::repo_store::migrate_repo_store(&h.db).unwrap();
    let listed = h.ok(OWNER, json!({"op":"repo_sessions","commit":mine}));
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 20);
}

#[test]
fn upgrades_from_the_members_schema_with_an_empty_sessions_table() {
    use crate::storage::SqlStore;
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..26])
        .unwrap();
    db.query("INSERT INTO repo_settings(id,workspace,owner,object_store,policy,policy_digest,created_at) VALUES('repository','ws-1','user:owner','r2','{}','d',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(db.query("SELECT id FROM sessions", &[]).unwrap().is_empty());
    assert_eq!(
        db.query("SELECT owner FROM repo_settings", &[]).unwrap()[0]["owner"],
        "user:owner"
    );
}

#[test]
fn a_session_id_ties_records_across_commits() {
    let (h, root) = seeded();
    let commits: Vec<String> = (0..3)
        .map(|n| {
            h.commit(
                AGENT,
                Some(&root),
                1,
                json!([file(&format!("src/f{n}.rs"), "x\n")]),
                json!([]),
            )
            .unwrap()
        })
        .collect();
    let with_id = |commit: &str, summary: &str, id: Value| {
        let mut s = session(commit, summary);
        s["session_id"] = id;
        s
    };
    h.ok(
        AGENT,
        with_id(&commits[0], "first", json!("opencode:ses_a")),
    );
    h.ok(
        AGENT,
        with_id(&commits[1], "second", json!("opencode:ses_b")),
    );
    h.ok(
        AGENT,
        with_id(&commits[2], "third", json!("opencode:ses_a")),
    );
    h.ok(AGENT, session(&commits[2], "no id"));
    // The same record with another session id is another record.
    let again = h.ok(
        AGENT,
        with_id(&commits[0], "first", json!("opencode:ses_c")),
    );
    assert!(again["already"].is_null());
    for bad in [json!("has space"), json!("x".repeat(129)), json!(7)] {
        assert_eq!(
            code(h.run(AGENT, with_id(&commits[0], "bad", bad))),
            "INVALID_INPUT"
        );
    }

    let listed = h.ok(CI, json!({"op":"repo_sessions","commit":commits[0]}));
    assert_eq!(listed["sessions"][0]["session_id"], "opencode:ses_a");
    // The repository-wide listing (agent_reads) filters by it.
    let one = h.ok(
        CI,
        json!({"op":"repo_session_list","session_id":"opencode:ses_a"}),
    );
    let summaries: Vec<&str> = one["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["summary"].as_str().unwrap())
        .collect();
    assert_eq!(summaries, ["third", "first"]);
}

#[test]
fn agent_context_gathers_sessions_changes_rules_and_contracts() {
    use crate::storage::SqlStore;
    let (h, root) = seeded();
    let fix = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/net.rs", "pub fn retry() {}\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_batch","updates":[{"ref":"fix","commit":fix,"expected":null}]}),
    );
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Retry with backoff"}),
    );
    h.ok(AGENT, session(&fix, "Added retry() to src/net.rs."));
    for (seq, path, symbol) in [
        (1, "src/other.rs", "other"),
        (2, "src/net.rs", "retry"),
        (3, "src/net.rs", "retry"),
        (4, "src/z.rs", "z"),
    ] {
        h.db.query(
            "INSERT INTO symbol_contracts(seq,path,symbol_path,commit_id,node_digest,contract,contract_digest,recorded_by,recorded_at,recorded_version) VALUES(?,?,?,?,?,?,?,?,?,?)",
            &[json!(seq), json!(path), json!(symbol), json!(fix), json!("d".repeat(64)),
              json!(format!("{{\"summary\":\"v{seq}\"}}")), json!("c".repeat(64)), json!(AGENT), json!(seq), json!(1)],
        )
        .unwrap();
    }
    let got = h.ok(
        CI,
        json!({"op":"repo_agent_context","branch":"fix","paths":["src/net.rs"],"contracts":2}),
    );
    assert_eq!(got["main"], root);
    assert_eq!(got["branch"], json!({"name":"fix","head":fix}));
    assert!(got["policy"].is_object());
    assert_eq!(
        got["sessions"][0]["summary"],
        "Added retry() to src/net.rs."
    );
    assert_eq!(got["changes"][0]["title"], "Retry with backoff");
    assert_eq!(got["changes"][0]["head"], fix);
    // The newest record of each contract, the agent's paths first.
    let contracts = got["contracts"].as_array().unwrap();
    assert_eq!(contracts.len(), 2);
    assert_eq!(contracts[0]["contract"]["summary"], "v3");
    assert_eq!(contracts[0]["on_paths"], true);
    assert_eq!(contracts[1]["path"], "src/z.rs");
    // Without a branch or paths it still answers; bad input is refused.
    let plain = h.ok(CI, json!({"op":"repo_agent_context"}));
    assert!(plain["branch"].is_null());
    assert_eq!(plain["contracts"][0]["path"], "src/z.rs");
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_agent_context","paths":["../x"]}))),
        "UNSAFE_PATH"
    );
    for bad in [
        json!({"paths":"src/"}),
        json!({"branch":"bad..name"}),
        json!({"sessions":0}),
        json!({"changes":21}),
    ] {
        let mut op = bad;
        op["op"] = json!("repo_agent_context");
        assert_eq!(code(h.run(CI, op.clone())), "INVALID_INPUT", "{op}");
    }
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run("token:docs", json!({"op":"repo_agent_context"}))),
        "FORBIDDEN"
    );
}

#[test]
fn upgrades_from_the_lfs_schema_with_session_ids_null() {
    use crate::storage::SqlStore;
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations
        .iter()
        .position(|(version, _)| *version == 34)
        .unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO sessions(commit_id,cli,summary,recorded_by,at) VALUES('c','x','old','user:owner',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    let rows = db
        .query("SELECT summary,session_id FROM sessions", &[])
        .unwrap();
    assert_eq!(rows[0]["summary"], "old");
    assert!(rows[0]["session_id"].is_null());
}

fn stored_meta(sha: char) -> Value {
    json!({"sha256": sha.to_string().repeat(64), "bytes": 2048, "turns": 12,
           "redactions": 1, "truncated": false, "context": true})
}

#[test]
fn a_record_names_the_transcript_stored_for_it() {
    let (h, root) = seeded();
    let mine = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn t() {}\n")]),
            json!([]),
        )
        .unwrap();
    let mut with = session(&mine, "With a transcript.");
    with["transcript_ref"] = Value::Null;
    with["transcript"] = stored_meta('a');
    // A dry run checks the record without keeping it (the adapter uploads in between).
    let mut dry = with.clone();
    dry["dry_run"] = json!(true);
    assert_eq!(h.ok(AGENT, dry.clone())["dry_run"], true);
    assert!(
        h.ok(CI, json!({"op":"repo_sessions","commit":mine}))["sessions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let posted = h.ok(AGENT, with.clone());
    // A dry run of a record already kept answers it, so nothing is uploaded again.
    let again = h.ok(AGENT, dry);
    assert_eq!(
        (again["session"].clone(), again["already"].clone()),
        (posted["session"].clone(), json!(true))
    );
    let listed = &h.ok(CI, json!({"op":"repo_sessions","commit":mine}))["sessions"][0];
    assert_eq!(listed["transcript"], stored_meta('a'));
    // The stored transcript fills an absent transcript_ref.
    assert_eq!(
        listed["transcript_ref"],
        format!("transcript:sha256:{}", "a".repeat(64))
    );
    let id = posted["session"].clone();
    let shown = h.ok(CI, json!({"op":"repo_session_show","id":id}));
    assert_eq!(shown["session"]["transcript"], stored_meta('a'));
    let found = h.ok(CI, json!({"op":"repo_session_transcript","id":id}));
    assert_eq!(
        found,
        json!({"session": id, "transcript": stored_meta('a')})
    );
    // A record without one, and a record that does not exist, have none to read.
    let plain = h.ok(AGENT, session(&mine, "Without one."));
    let none = h.run(
        CI,
        json!({"op":"repo_session_transcript","id":plain["session"]}),
    );
    assert_eq!(code(none), "NOT_FOUND");
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_session_transcript","id":999}))),
        "NOT_FOUND"
    );
    assert!(h.ok(CI, json!({"op":"repo_session_list"}))["sessions"][0]["transcript"].is_null());
    // The metadata is the adapter's: anything else is refused.
    for (key, bad) in [
        ("sha256", json!("A".repeat(64))),
        ("bytes", json!(0)),
        ("bytes", json!(2 * 1024 * 1024)),
        ("turns", json!(-1)),
        ("truncated", json!("no")),
    ] {
        let mut wrong = with.clone();
        wrong["summary"] = json!("other");
        wrong["transcript"][key] = bad;
        assert_eq!(code(h.run(AGENT, wrong)), "INVALID_INPUT", "{key}");
    }
    // A path-restricted token reads no transcript, as it reads no session.
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(h.run(
            "token:docs",
            json!({"op":"repo_session_transcript","id":id})
        )),
        "FORBIDDEN"
    );
}

#[test]
fn a_private_repository_hides_transcripts_from_non_members() {
    let (h, root) = seeded();
    let mine = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn t() {}\n")]),
            json!([]),
        )
        .unwrap();
    let mut with = session(&mine, "With a transcript.");
    with["transcript"] = stored_meta('b');
    let id = h.ok(AGENT, with)["session"].clone();
    let read = |credentials: Value| {
        let mut c = json!({"op":"repo_session_transcript","id":id,"now":1});
        for (key, value) in credentials.as_object().unwrap() {
            c[key] = value.clone();
        }
        crate::repo_store::execute_repo_store(&h.db, c)
    };
    let stranger =
        json!({"_session": {"workspace": "stranger", "principal": "user:stranger", "human": true}});
    for who in [json!({"_anonymous": true}), stranger.clone()] {
        assert_eq!(code(read(who)), "NOT_FOUND");
    }
    h.ok(
        OWNER,
        json!({"op":"repo_set_visibility","visibility":"public"}),
    );
    assert_eq!(read(stranger).unwrap()["transcript"], stored_meta('b'));
}

#[test]
fn upgrades_from_the_visibility_schema_with_no_transcripts() {
    use crate::storage::SqlStore;
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations
        .iter()
        .position(|(version, _)| *version == 37)
        .unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO sessions(commit_id,cli,summary,recorded_by,at) VALUES('c','x','old','user:owner',1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    let rows = db
        .query("SELECT summary,transcript FROM sessions", &[])
        .unwrap();
    assert_eq!(rows[0]["summary"], "old");
    assert!(rows[0]["transcript"].is_null());
}

/// A placeholder is no model: "none", "" and the like are stored as null, never shown as a
/// model or offered by the Model filter, also for rows recorded before this rule; a real
/// model id is kept as given.
#[test]
fn a_placeholder_model_is_stored_and_listed_as_none_at_all() {
    use crate::storage::SqlStore;
    let (h, root) = seeded();
    let mut commits = Vec::new();
    for (i, model) in [
        json!("none"),
        json!(""),
        json!(" None "),
        json!("unknown"),
        Value::Null,
        json!("zai-coding-plan/glm-5.3"),
    ]
    .into_iter()
    .enumerate()
    {
        let id = h
            .commit(
                AGENT,
                Some(&root),
                1,
                json!([file(&format!("src/m{i}.rs"), "x\n")]),
                json!([]),
            )
            .unwrap();
        let mut record = session(&id, &format!("session {i}"));
        record["model"] = model;
        h.ok(AGENT, record);
        commits.push(id);
    }
    let models: Vec<Value> = commits
        .iter()
        .map(|c| h.ok(CI, json!({"op":"repo_sessions","commit":c}))["sessions"][0]["model"].clone())
        .collect();
    assert_eq!(
        models,
        [
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            json!("zai-coding-plan/glm-5.3")
        ]
    );
    // A row from before the rule still reads as no model, and is not a filter option.
    h.db.query(
        "UPDATE sessions SET model='none' WHERE summary='session 4'",
        &[],
    )
    .unwrap();
    let all = h.ok(CI, json!({"op":"repo_session_list"}));
    assert_eq!(all["models"], json!(["zai-coding-plan/glm-5.3"]));
    assert!(
        all["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["model"] != "none")
    );
    let per_commit = h.ok(CI, json!({"op":"repo_sessions","commit":commits[4]}));
    assert_eq!(per_commit["sessions"][0]["model"], Value::Null);
}
