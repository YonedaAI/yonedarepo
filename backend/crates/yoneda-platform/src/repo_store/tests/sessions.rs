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
