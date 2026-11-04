//! Activity summary for the account Home: commits made or pushed per hour, the newest session
//! records, landed changes and whether anything but the import ever landed. Only the
//! platform's derive job reads it; it is projected to D1 for the account page.
use super::*;
use crate::storage::SqlStore;

const DERIVE: &str = "platform:derive";
const HOUR: i64 = 3_600_000;

#[test]
fn contribution_pages_match_the_chart_snapshot_and_exclude_later_work() {
    let (h, root) = seeded();
    let at = 1_800_000_000_000_i64;
    // Recorded time, not author time; imports and forks never contribute.
    h.db.query(
        "UPDATE commits SET recorded_at=?, origin='push' WHERE id=?",
        &[json!(at), json!(root)],
    )
    .unwrap();
    h.db.query("INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,origin) VALUES(?, 't','[]',1,0,'user:owner','Second','[]',?,'platform')", &[json!("b".repeat(40)), json!(at + 1)]).unwrap();
    h.db.query("INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,origin) VALUES(?, 't','[]',1,0,'user:owner','Imported','[]',?,'import')", &[json!("c".repeat(40)), json!(at)]).unwrap();
    let summary = h.ok(DERIVE, json!({"op":"repo_activity","since":at}));
    let mut ask = json!({"op":"repo_contributions","hours":[at - at % HOUR],"since":at,"snapshot":summary["snapshot"],"limit":1});
    let first = h.ok(OWNER, ask.clone());
    assert_eq!(first["total"], 2);
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["items"][0]["commit"], root);
    h.db.query("INSERT INTO commits(id,tree,parents,generation,base_version,principal,message,read_set,recorded_at,origin) VALUES(?, 't','[]',1,0,'user:owner','Later','[]',?,'push')", &[json!("d".repeat(40)), json!(at + 2)]).unwrap();
    ask["after"] = first["next"].clone();
    let second = h.ok(OWNER, ask.clone());
    assert_eq!(second["items"][0]["commit"], "b".repeat(40));
    assert_eq!(second["next"], Value::Null);
    assert_eq!(summary["commits"][0][1], 2);
    ask["hours"] = json!([at + 1]);
    assert_eq!(code(h.run(OWNER, ask)), "INVALID_INPUT");
}

#[test]
fn contribution_details_deduplicate_before_filtering_and_require_whole_repo_access() {
    let (h, root) = seeded();
    h.db.query(
        "UPDATE commits SET recorded_at=? WHERE id=?",
        &[json!(HOUR + 1), json!(root)],
    )
    .unwrap();
    // An earlier shard record puts this commit in the preceding bucket, not both.
    h.db.query("INSERT INTO changesets(version,refname,commit_id,landed_at,recorded_at,message) VALUES(8,'refs/heads/main',?,?,?,'Earlier')", &[json!(root),json!(HOUR + 1),json!(HOUR - 1)]).unwrap();
    let shard = "e".repeat(40);
    for version in [9, 10] {
        h.db.query("INSERT INTO changesets(version,refname,commit_id,landed_at,recorded_at,message) VALUES(?,'refs/heads/main',?,?,?,'Shard')", &[json!(version),json!(shard),json!(HOUR + 9),json!(HOUR + 5)]).unwrap();
    }
    let summary = h.ok(DERIVE, json!({"op":"repo_activity","since":0}));
    let ask =
        json!({"op":"repo_contributions","hours":[HOUR],"since":0,"snapshot":summary["snapshot"]});
    let page = h.ok(OWNER, ask.clone());
    assert_eq!(page["total"], 1);
    assert_eq!(page["items"][0]["commit"], shard);
    assert_eq!(page["items"][0]["subject"], "Shard");
    assert_eq!(code(h.run("member:stranger", ask.clone())), "NOT_FOUND");
    h.ok(OWNER,json!({"op":"repo_token_create","name":"partial","scopes":["read"],"paths":["docs/"],"_secret":"partial-secret-0123456789abcdef0123456789"}));
    assert_eq!(code(h.run("token:partial", ask)), "FORBIDDEN");
}

fn session(commit: &str, summary: &str) -> Value {
    json!({ "op": "repo_session_record", "commit": commit, "cli": "opencode",
            "model": "glm-5.3", "summary": summary, "session_id": "opencode:ses_1" })
}

#[test]
fn activity_counts_landed_commits_sessions_and_changes() {
    let (h, root) = seeded();
    let activity = |since: i64| h.ok(DERIVE, json!({"op":"repo_activity","since":since}));
    // Only the seed landed (by import): one commit, nothing pushed, no sessions or changes.
    let fresh = activity(0);
    assert_eq!(fresh["pushed"], false);
    assert_eq!(fresh["commits_total"], 1);
    assert_eq!(fresh["sessions"], json!([]));
    assert_eq!(fresh["last_session_at"], Value::Null);
    assert_eq!(fresh["changes_landed"], json!([]));
    assert_eq!(fresh["changes_landed_total"], 0);

    // A change on a branch, its commit landed on main: one more commit, on two refs.
    let id = h
        .commit(
            AGENT,
            Some(&root),
            1,
            json!([file("src/x.rs", "x\n")]),
            json!([]),
        )
        .unwrap();
    h.ok(
        AGENT,
        json!({"op":"repo_branch_set","ref":"fix","commit":id,"expected":null}),
    );
    h.ok(
        AGENT,
        json!({"op":"repo_change_create","branch":"fix","title":"Fix","body":""}),
    );
    h.approve_and_check(&id);
    h.ok(OWNER, json!({"op":"repo_land","ref":"main","commit":id}));
    h.ok(AGENT, session(&id, "first"));
    h.ok(AGENT, session(&id, "second"));

    let now = activity(0);
    assert_eq!(now["pushed"], true);
    // A commit counts once, however many refs it reached.
    assert_eq!(now["commits_total"], 2);
    let buckets = now["commits"].as_array().unwrap();
    let counted: i64 = buckets.iter().map(|b| b[1].as_i64().unwrap()).sum();
    assert_eq!(counted, 2);
    assert!(buckets.iter().all(|b| b[0].as_i64().unwrap() % HOUR == 0));
    // Newest first, with the commit's subject; the summary's count and newest time.
    let sessions = now["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["summary"], "second");
    assert_eq!(sessions[0]["commit"], json!(id));
    assert_eq!(sessions[0]["cli"], "opencode");
    assert_eq!(now["last_session_at"], sessions[0]["at"]);
    assert_eq!(now["changes_landed"].as_array().unwrap().len(), 1);
    assert_eq!(now["changes_landed_total"], 1);

    // A window after everything keeps the totals and drops the timed rows.
    let later = activity(i64::MAX / 2);
    assert_eq!(later["commits"], json!([]));
    assert_eq!(later["changes_landed"], json!([]));
    assert_eq!(later["commits_total"], 2);
    assert_eq!(later["sessions"].as_array().unwrap().len(), 2);

    // Agents and readers never read it: the summary spans paths and sessions.
    assert_eq!(
        code(h.run(AGENT, json!({"op":"repo_activity","since":0}))),
        "FORBIDDEN"
    );
    assert_eq!(
        code(h.run(DERIVE, json!({"op":"repo_activity","since":"x"}))),
        "INVALID_INPUT"
    );
}
