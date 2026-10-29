//! One query across commits, session records and change requests (`repo_search_records`):
//! each its own group with a count and at most `limit` results, ranked by where the
//! query's words appear (a commit's subject before its body, its author and the paths it
//! touched), then newest first. A path-restricted token finds only commits that touch its
//! grant (listing only those paths) and no sessions or changes; a quarantined session
//! record is never found. The full-text tables follow their rows by trigger and arrive by
//! an additive migration that indexes what was there.
use super::*;
use crate::storage::SqlStore;

const RESTRICTED: &str = "token:docs";

fn commit_message(h: &Harness, parent: &str, path: &str, message: &str) -> String {
    h.commit_with(
        AGENT,
        Some(parent),
        1,
        json!([file(path, &format!("{message}\n"))]),
        json!([path]),
        json!({ "message": message }),
    )
    .unwrap()
}

fn search(h: &Harness, who: &str, query: &str) -> Value {
    h.ok(who, json!({"op":"repo_search_records","query":query}))
}

fn ids(group: &Value, key: &str) -> Vec<Value> {
    group["results"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[key].clone())
        .collect()
}

#[test]
fn one_query_finds_commits_sessions_and_changes_ranked_deterministically() {
    let (h, root) = seeded();
    // The body names both words; the newer subject names them: the subject ranks first.
    let body = commit_message(
        &h,
        &root,
        "src/net.rs",
        "Tidy the client\n\nRetry the fetch with backoff.",
    );
    let subject = commit_message(&h, &root, "src/fetch.rs", "Retry fetches with backoff");
    let unrelated = commit_message(&h, &root, "src/other.rs", "Rename a helper");
    h.ok(
        AGENT,
        json!({"op":"repo_session_record","commit":subject,"cli":"opencode",
        "summary":"Added a retry budget and backoff to the fetcher","session_id":"opencode:ses_1"}),
    );
    h.ok(AGENT, json!({"op":"repo_branch_batch","updates":[{"ref":"retry","commit":subject,"expected":null}]}));
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"retry","title":"Retry with backoff",
        "body":"Fixes flaky fetches."}),
    );

    let found = search(&h, CI, "retry backoff");
    let commits = &found["commits"];
    assert_eq!(commits["count"], 2);
    assert_eq!(ids(commits, "commit"), [json!(subject), json!(body)]);
    assert_eq!(
        commits["results"][0]["subject"],
        "Retry fetches with backoff"
    );
    assert_eq!(
        commits["results"][0]["matched"],
        json!(["subject", "message"])
    );
    assert_eq!(commits["results"][0]["paths"], json!(["src/fetch.rs"]));
    assert_eq!(commits["results"][1]["matched"], json!(["message"]));
    assert_eq!(found["sessions"]["count"], 1);
    assert_eq!(found["sessions"]["results"][0]["commit"], json!(subject));
    assert_eq!(
        found["sessions"]["results"][0]["reads"],
        json!(["src/fetch.rs"])
    );
    assert_eq!(found["changes"]["count"], 1);
    assert_eq!(
        found["changes"]["results"][0]["title"],
        "Retry with backoff"
    );
    // The same query answers the same, in the same order.
    assert_eq!(search(&h, CI, "retry backoff"), found);

    // A touched path and the session's declared reads match by their words.
    let by_path = search(&h, CI, "src/other.rs");
    assert_eq!(ids(&by_path["commits"], "commit"), [json!(unrelated)]);
    assert_eq!(
        by_path["commits"]["results"][0]["matched"],
        json!(["paths"])
    );
    assert_eq!(search(&h, CI, "fetch.rs")["sessions"]["count"], 1);
    // The author (the principal that recorded the commit) and a commit id prefix match.
    assert_eq!(search(&h, CI, "agent")["commits"]["count"], 3);
    let by_id = search(&h, CI, &unrelated[..10]);
    assert_eq!(ids(&by_id["commits"], "commit"), [json!(unrelated)]);
    // Groups are asked for by name; one left out is null.
    let only = h.ok(
        CI,
        json!({"op":"repo_search_records","query":"retry","groups":["changes"]}),
    );
    assert!(only["commits"].is_null() && only["sessions"].is_null());
    assert_eq!(only["changes"]["count"], 1);
    for bad in [
        json!({"query":"x"}),
        json!({"query":"retry","groups":["code"]}),
        json!({"query":"retry","limit":0}),
    ] {
        let mut command = bad.clone();
        command["op"] = json!("repo_search_records");
        assert_eq!(code(h.run(CI, command)), "INVALID_INPUT", "{bad}");
    }
}

#[test]
fn groups_are_bounded_and_count_every_match() {
    let (h, _) = seeded();
    for n in 0..120 {
        h.db.query(
            "INSERT INTO changes(title,body,branch,author,status,created_at,updated_at) VALUES(?,?,?,'user:owner','closed',?,?)",
            &[json!(format!("Flaky test {n}")), json!(""), json!(format!("b{n}")), json!(n), json!(n)],
        )
        .unwrap();
    }
    let found = h.ok(
        CI,
        json!({"op":"repo_search_records","query":"flaky","limit":5}),
    );
    assert_eq!(found["changes"]["count"], 120);
    let titles: Vec<Value> = ids(&found["changes"], "title");
    let newest: Vec<Value> = (115..120)
        .rev()
        .map(|n| json!(format!("Flaky test {n}")))
        .collect();
    assert_eq!(titles, newest);
    // An edited title is found by its new words only; a deleted change is gone.
    h.db.query(
        "UPDATE changes SET title='Stable now' WHERE branch='b119'",
        &[],
    )
    .unwrap();
    h.db.query("DELETE FROM changes WHERE branch='b118'", &[])
        .unwrap();
    assert_eq!(search(&h, CI, "flaky")["changes"]["count"], 118);
    assert_eq!(search(&h, CI, "stable")["changes"]["count"], 1);
}

#[test]
fn a_restricted_token_finds_only_commits_in_its_grant_and_quarantine_hides_sessions() {
    let (h, root) = seeded();
    h.ok(
        OWNER,
        json!({"op":"repo_token_create","name":"docs","scopes":["read"],"paths":["docs/"],
        "_secret":"docs-secret-0123456789abcdef0123456789"}),
    );
    let hidden = commit_message(&h, &root, "src/retry.rs", "Retry inside src");
    let mixed = h
        .commit_with(
            AGENT,
            Some(&root),
            1,
            json!([file("docs/retry.md", "r\n"), file("src/retry2.rs", "r\n")]),
            json!([]),
            json!({ "message": "Retry documented" }),
        )
        .unwrap();
    let recorded = h.ok(
        AGENT,
        json!({"op":"repo_session_record","commit":hidden,"cli":"opencode",
        "summary":"Retry work"}),
    );

    let restricted = search(&h, RESTRICTED, "retry");
    assert_eq!(ids(&restricted["commits"], "commit"), [json!(mixed)]);
    assert_eq!(
        restricted["commits"]["results"][0]["paths"],
        json!(["docs/retry.md"])
    );
    assert!(restricted["sessions"].is_null() && restricted["changes"].is_null());
    // A path outside the grant matches nothing for it.
    assert_eq!(search(&h, RESTRICTED, "retry2")["commits"]["count"], 0);

    assert_eq!(search(&h, CI, "retry")["sessions"]["count"], 1);
    h.ok(OWNER, json!({"op":"repo_quarantine","target":{"kind":"session","id":recorded["session"].to_string()},
        "reason":"a leaked credential"}));
    assert_eq!(search(&h, CI, "retry")["sessions"]["count"], 0);
}

#[test]
fn upgrades_from_the_session_fetch_schema_indexing_what_is_there() {
    let db = crate::native::NativeStore::memory().unwrap();
    let migrations = &super::super::migration::MIGRATIONS;
    let before = migrations
        .iter()
        .position(|(version, _)| *version == 42)
        .unwrap();
    super::super::migration::migrate_with(&db, "repo_schema_migrations", &migrations[..before])
        .unwrap();
    db.query("INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at) VALUES('c1','t','[]',1,0,'user:owner','Retry the fetch','[\"src/a.rs\"]',1)", &[]).unwrap();
    db.query(
        "INSERT INTO commit_paths(commit_id,path,op) VALUES('c1','src/a.rs','write')",
        &[],
    )
    .unwrap();
    db.query("INSERT INTO sessions(commit_id,cli,summary,recorded_by,at) VALUES('c1','x','Retry budget','user:owner',1)", &[]).unwrap();
    db.query("INSERT INTO changes(title,body,branch,author,status,created_at,updated_at) VALUES('Retry','','b','user:owner','open',1,1)", &[]).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    super::super::migrate_repo_store(&db).unwrap();
    for (table, expected) in [
        ("commit_text", 1),
        ("commit_path_text", 1),
        ("session_text", 1),
        ("change_text", 1),
    ] {
        let rows = db
            .query(
                &format!("SELECT COUNT(*) AS n FROM {table} WHERE {table} MATCH 'retry OR src'"),
                &[],
            )
            .unwrap();
        assert_eq!(rows[0]["n"], expected, "{table}");
    }
}
