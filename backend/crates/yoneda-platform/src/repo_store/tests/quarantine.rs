//! Quarantine: the owner (or an admin) withholds a blob or a session record's text without
//! rewriting any id. Readers learn which blobs are withheld from every access answer
//! (status, the published head, Git access) and are refused a direct Artifacts clone; a
//! session record reads masked. Purge is leased and fenced like the LFS sweep, keeps the
//! record, and a purged blob stays withheld. The table arrives by an additive migration.
use super::*;
use crate::storage::SqlStore;

const ADMIN: &str = "member:ada";
const DAY: i64 = 24 * 60 * 60 * 1000;

fn blob_id(text: &str) -> String {
    hash_object(ObjectKind::Blob, text.as_bytes()).hex()
}

fn quarantine(kind: &str, id: &str) -> Value {
    json!({"op":"repo_quarantine","target":{"kind":kind,"id":id},"path":"src/lib.rs",
           "reason":"a leaked credential"})
}

fn as_quarantine_job(h: &Harness, mut c: Value) -> yoneda_core::Result<Value> {
    *h.now.borrow_mut() += 1_000;
    c["now"] = json!(*h.now.borrow());
    c["_system"] = json!("quarantine");
    execute_repo_store(&h.db, c)
}

fn admin(h: &Harness) {
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"ada","role":"admin"}),
    );
}

fn head_access_version(h: &Harness) -> Value {
    h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    )["access_version"]
        .clone()
}

#[test]
fn a_quarantined_blob_is_withheld_until_purged_and_its_record_kept() {
    let (h, _) = seeded();
    admin(&h);
    let blob = blob_id("pub fn a() {}\n");
    let before = head_access_version(&h);
    // Writers and readers may not quarantine; the owner and an admin may.
    assert_eq!(code(h.run(AGENT, quarantine("blob", &blob))), "FORBIDDEN");
    assert_eq!(code(h.run(CI, quarantine("blob", &blob))), "FORBIDDEN");
    assert_eq!(
        code(h.run(ADMIN, quarantine("blob", "not-a-blob"))),
        "INVALID_INPUT"
    );
    let mut no_reason = quarantine("blob", &blob);
    no_reason["reason"] = json!(" ");
    assert_eq!(code(h.run(ADMIN, no_reason)), "INVALID_INPUT");
    let made = h.ok(ADMIN, quarantine("blob", &blob));
    let record = made["record"].clone();
    assert_eq!(record["state"], "quarantined");
    assert_eq!(record["target"], json!({"kind":"blob","id":blob}));
    assert_eq!(record["path"], "src/lib.rs");
    assert_eq!(record["actor"], "user:ada");
    assert_eq!(record["reason"], "a leaked credential");
    // Purged by the job after the default retention, which the answer schedules.
    assert_eq!(made["purge_at"], record["purge_after"]);
    assert_eq!(
        record["purge_after"].as_i64().unwrap() - record["at"].as_i64().unwrap(),
        7 * DAY
    );
    // Again: the same record.
    let again = h.ok(OWNER, quarantine("blob", &blob));
    assert_eq!(
        (again["record"]["id"].clone(), again["already"].clone()),
        (record["id"].clone(), json!(true))
    );

    // Every access answer names it, and the access snapshot changes with it.
    let withheld = json!([{"id": blob, "path": "src/lib.rs"}]);
    let status = h.ok(CI, json!({"op":"repo_status"}));
    assert_eq!(status["quarantined"], withheld);
    let epoch = status["quarantine_epoch"].as_u64().unwrap();
    assert!(epoch > 0);
    let head = h.ok(
        "platform:projection",
        json!({"op":"repo_head","ref":"main"}),
    );
    assert_eq!(head["quarantined"], withheld);
    assert_eq!(head["quarantine_epoch"], epoch);
    assert_ne!(head["access_version"], before);
    let git = h.ok(
        CI,
        json!({"op":"repo_git_access","service":"git-upload-pack"}),
    );
    assert_eq!(git["quarantined"], withheld);
    // Artifacts would serve the bytes to a direct clone: refused while anything is withheld.
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"hugo","role":"read"}),
    );
    assert_eq!(
        code(h.run("member:hugo", json!({"op":"repo_clone_access"}))),
        "QUARANTINED"
    );

    // Only the owner side lists records.
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_quarantines"}))),
        "FORBIDDEN"
    );
    let listed = h.ok(OWNER, json!({"op":"repo_quarantines"}));
    assert_eq!(listed["records"].as_array().unwrap().len(), 1);

    // Purge now needs the target id as confirmation; it leases the record.
    let id = record["id"].clone();
    for confirm in [json!(null), json!("other")] {
        assert_eq!(
            code(h.run(
                OWNER,
                json!({"op":"repo_quarantine_purge","id":id,"confirm":confirm})
            )),
            "INVALID_INPUT"
        );
    }
    let claimed = h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purge","id":id,"confirm":blob}),
    );
    let claim = claimed["claims"][0].clone();
    assert_eq!(claim["target"], json!({"kind":"blob","id":blob}));
    // Bytes may be half gone while the lease runs: no release, no second claim.
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_quarantine_release","id":id}))),
        "CONFLICT"
    );
    assert_eq!(
        code(h.run(
            OWNER,
            json!({"op":"repo_quarantine_purge","id":id,"confirm":blob})
        )),
        "CONFLICT"
    );
    // A stale epoch is fenced; the current one marks it purged.
    let stale = json!([{"id": id, "epoch": claim["epoch"].as_i64().unwrap() - 1}]);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_quarantine_purged","claims":stale}))["purged"],
        0
    );
    let done = json!([{"id": id, "epoch": claim["epoch"]}]);
    assert_eq!(
        h.ok(OWNER, json!({"op":"repo_quarantine_purged","claims":done}))["purged"],
        1
    );
    let kept = &h.ok(OWNER, json!({"op":"repo_quarantines"}))["records"][0];
    assert_eq!(kept["state"], "purged");
    assert_eq!(kept["purged_by"], OWNER);
    assert_eq!(kept["reason"], "a leaked credential");
    // A purged blob is never served again (the object store may still hold it), and its
    // record cannot be released.
    assert_eq!(
        h.ok(CI, json!({"op":"repo_status"}))["quarantined"],
        withheld
    );
    assert_eq!(
        code(h.run(OWNER, json!({"op":"repo_quarantine_release","id":id}))),
        "CONFLICT"
    );
}

#[test]
fn a_released_blob_is_served_again_under_a_new_epoch() {
    let (h, _) = seeded();
    let blob = blob_id("# demo\n");
    let id = h.ok(OWNER, quarantine("blob", &blob))["record"]["id"].clone();
    let epoch = h.ok(CI, json!({"op":"repo_status"}))["quarantine_epoch"].clone();
    let released = h.ok(OWNER, json!({"op":"repo_quarantine_release","id":id}));
    assert_eq!(released["record"]["state"], "released");
    assert_eq!(released["record"]["released_by"], OWNER);
    let status = h.ok(CI, json!({"op":"repo_status"}));
    assert_eq!(status["quarantined"], json!([]));
    assert!(status["quarantine_epoch"].as_u64() > epoch.as_u64());
    h.ok(
        OWNER,
        json!({"op":"repo_member_put","account":"hugo","role":"read"}),
    );
    h.ok("member:hugo", json!({"op":"repo_clone_access"}));
    // The same blob may be quarantined again: a new record.
    let again = h.ok(OWNER, quarantine("blob", &blob))["record"]["id"].clone();
    assert_ne!(again, id);
}

#[test]
fn the_quarantine_job_purges_due_records_under_a_fenced_lease() {
    let (h, _) = seeded();
    let blob = blob_id("pub fn a() {}\n");
    let mut short = quarantine("blob", &blob);
    short["retain_days"] = json!(1);
    let record = h.ok(OWNER, short)["record"].clone();
    // Only the platform's quarantine job claims.
    for who in [OWNER, CI, "platform:lfs"] {
        assert_eq!(
            code(h.run(who, json!({"op":"repo_quarantine_claim","limit":10}))),
            "FORBIDDEN"
        );
    }
    let early = as_quarantine_job(&h, json!({"op":"repo_quarantine_claim","limit":10})).unwrap();
    assert_eq!(early["claims"], json!([]));
    assert_eq!(early["next_at"], record["purge_after"]);
    *h.now.borrow_mut() += DAY;
    let first = as_quarantine_job(&h, json!({"op":"repo_quarantine_claim","limit":10})).unwrap();
    assert_eq!(first["claims"].as_array().unwrap().len(), 1);
    // Leased: a second run claims nothing until the lease runs out.
    let busy = as_quarantine_job(&h, json!({"op":"repo_quarantine_claim","limit":10})).unwrap();
    assert_eq!(busy["claims"], json!([]));
    *h.now.borrow_mut() += 10 * 60 * 1000;
    let second = as_quarantine_job(&h, json!({"op":"repo_quarantine_claim","limit":10})).unwrap();
    let late = first["claims"][0]["epoch"].clone();
    let current = second["claims"][0]["epoch"].clone();
    assert_ne!(late, current);
    let report = |epoch: &Value| {
        as_quarantine_job(
            &h,
            json!({"op":"repo_quarantine_purged","claims":[{"id":record["id"],"epoch":epoch}]}),
        )
        .unwrap()["purged"]
            .clone()
    };
    assert_eq!(report(&late), 0);
    assert_eq!(report(&current), 1);
    let done = as_quarantine_job(&h, json!({"op":"repo_quarantine_claim","limit":10})).unwrap();
    assert_eq!(
        (done["claims"].clone(), done["next_at"].clone()),
        (json!([]), Value::Null)
    );
}

#[test]
fn a_quarantined_session_record_reads_masked_and_purge_clears_its_text() {
    let (h, root) = seeded();
    let commit = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn b() {}\n")]),
            json!([]),
        )
        .unwrap();
    let record = |summary: &str| {
        h.ok(
            AGENT,
            json!({"op":"repo_session_record","commit":commit,"cli":"claude-code",
            "summary":summary,"transcript_ref":"claude-code:3f2a","session_id":"claude-code:s1"}),
        )["session"]
            .clone()
    };
    let leaked = record("pasted the staging password hunter2 into the notes");
    let kept = record("renamed a to b");
    assert_eq!(
        code(h.run(OWNER, quarantine("session", "999"))),
        "NOT_FOUND"
    );
    let id = h.ok(OWNER, quarantine("session", &leaked.to_string()))["record"]["id"].clone();
    // Blobs only travel in access answers.
    assert_eq!(
        h.ok(CI, json!({"op":"repo_status"}))["quarantined"],
        json!([])
    );
    let masked = |row: &Value| {
        if row["id"] == leaked {
            assert_eq!(
                (
                    row["summary"].clone(),
                    row["transcript_ref"].clone(),
                    row["quarantined"].clone()
                ),
                (Value::Null, Value::Null, json!(true)),
                "{row}"
            );
        } else {
            assert_eq!(row["summary"], "renamed a to b", "{row}");
            assert_eq!(row["quarantined"], Value::Null, "{row}");
        }
    };
    let reads = [
        h.ok(CI, json!({"op":"repo_sessions","commit":commit}))["sessions"].clone(),
        h.ok(CI, json!({"op":"repo_session_list"}))["sessions"].clone(),
        h.ok(CI, json!({"op":"repo_agent_context"}))["sessions"].clone(),
    ];
    for rows in &reads {
        assert_eq!(rows.as_array().unwrap().len(), 2);
        rows.as_array().unwrap().iter().for_each(masked);
    }
    let shown = h.ok(CI, json!({"op":"repo_session_show","id":leaked}));
    masked(&shown["session"]);
    let other = h.ok(CI, json!({"op":"repo_session_show","id":kept}));
    masked(&other["session"]);

    let claim = h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purge","id":id,"confirm":leaked.to_string()}),
    )["claims"][0]
        .clone();
    h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purged","claims":[{"id":id,"epoch":claim["epoch"]}]}),
    );
    let stored =
        h.db.query(
            "SELECT summary,transcript_ref FROM sessions WHERE id=?",
            std::slice::from_ref(&leaked),
        )
        .unwrap();
    assert_eq!(
        (
            stored[0]["summary"].clone(),
            stored[0]["transcript_ref"].clone()
        ),
        (json!(""), Value::Null)
    );
    masked(&h.ok(CI, json!({"op":"repo_session_show","id":leaked}))["session"]);
}

#[test]
fn path_restricted_tokens_cannot_quarantine() {
    let (h, _) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read","write"],
        "paths":["src"],"_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    assert_eq!(
        code(
            h.run("token:docs", json!({"op":"repo_status"}))
                .map(|s| s["quarantined"].clone())
        ),
        "OK"
    );
    assert_eq!(
        code(h.run(
            "token:docs",
            quarantine("blob", &blob_id("pub fn a() {}\n"))
        )),
        "FORBIDDEN"
    );
}

#[test]
fn upgrades_from_the_preceding_schema_with_records_intact() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let preceding = migrations.len() - 1;
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..preceding])
        .unwrap();
    db.query(
        "INSERT INTO sessions(commit_id,cli,summary,recorded_by,at) VALUES('c','x','kept','p',1)",
        &[],
    )
    .unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    assert!(
        db.query("SELECT id FROM quarantine", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        db.query("SELECT summary FROM sessions", &[]).unwrap()[0]["summary"],
        "kept"
    );
    assert_eq!(
        db.query("SELECT MAX(version) AS v FROM repo_schema_migrations", &[])
            .unwrap()[0]["v"],
        migrations.last().unwrap().0
    );
}

/// A stored transcript's metadata, as the adapter posts it after writing the document.
fn stored(sha: char) -> Value {
    json!({"sha256": sha.to_string().repeat(64), "bytes": 2048, "turns": 12,
           "redactions": 0, "truncated": false, "context": true})
}

#[test]
fn a_quarantined_session_withholds_its_stored_transcript_and_purge_names_it() {
    let (h, root) = seeded();
    let commit = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/lib.rs", "pub fn b() {}\n")]),
            json!([]),
        )
        .unwrap();
    let record = |summary: &str, sha: char| {
        h.ok(
            AGENT,
            json!({"op":"repo_session_record","commit":commit,"cli":"claude-code",
                   "summary":summary,"transcript":stored(sha)}),
        )["session"]
            .clone()
    };
    let leaked = record("pasted a password", 'a');
    let kept = record("renamed a to b", 'b');
    let id = h.ok(OWNER, quarantine("session", &leaked.to_string()))["record"]["id"].clone();

    // The metadata is masked on every read, and the document is refused.
    let shown = h.ok(CI, json!({"op":"repo_session_show","id":leaked}));
    assert_eq!(shown["session"]["transcript"], Value::Null);
    let listed = h.ok(CI, json!({"op":"repo_sessions","commit":commit}));
    assert_eq!(listed["sessions"][0]["transcript"], Value::Null);
    assert_eq!(listed["sessions"][1]["transcript"], stored('b'));
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_session_transcript","id":leaked}))),
        "QUARANTINED"
    );
    assert_eq!(
        h.ok(CI, json!({"op":"repo_session_transcript","id":kept}))["transcript"],
        stored('b')
    );

    // The claim names the document to delete; the report clears the column.
    let claim = h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purge","id":id,"confirm":leaked.to_string()}),
    )["claims"][0]
        .clone();
    assert_eq!(claim["transcript_sha256"], "a".repeat(64));
    h.ok(
        OWNER,
        json!({"op":"repo_quarantine_purged","claims":[{"id":id,"epoch":claim["epoch"]}]}),
    );
    let row =
        h.db.query(
            "SELECT summary,transcript_ref,transcript FROM sessions WHERE id=?",
            std::slice::from_ref(&leaked),
        )
        .unwrap();
    assert_eq!(
        (
            row[0]["summary"].clone(),
            row[0]["transcript_ref"].clone(),
            row[0]["transcript"].clone()
        ),
        (json!(""), Value::Null, Value::Null)
    );
    assert_eq!(
        code(h.run(CI, json!({"op":"repo_session_transcript","id":leaked}))),
        "QUARANTINED"
    );
}
