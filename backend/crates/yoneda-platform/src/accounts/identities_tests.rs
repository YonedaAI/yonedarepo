//! Sign-in provider identities, OAuth attempts and identity claims, and the migration that
//! adds them.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn github(subject: &str) -> Value {
    json!({"provider":"github","subject":subject,"login":"octocat","email":"octo@example.com"})
}
fn with(mut base: Value, extra: Value) -> Value {
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}
fn oauth_account() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let signup = with(
        github("42"),
        json!({"op":"identity_signup","username":"octocat","session_hash":"a".repeat(64)}),
    );
    let created = at(&db, 1000, signup).unwrap();
    assert_eq!(created["username"], "octocat");
    assert!(
        created.get("email").is_none(),
        "the public account carries no email"
    );
    let stored = db
        .query(
            "SELECT payload FROM workspace_records WHERE id='account'",
            &[],
        )
        .unwrap();
    assert!(
        stored[0]["payload"]
            .as_str()
            .unwrap()
            .contains("\"email\":\"octo@example.com\"")
    );
    db
}

#[test]
fn a_provider_account_signs_in_only_with_its_own_identity_and_has_no_password() {
    let db = oauth_account();
    let signin = |subject: &str, session: char| {
        at(
            &db,
            2000,
            json!({"op":"identity_signin","provider":"github","subject":subject,"session_hash":session.to_string().repeat(64)}),
        )
        .unwrap()["authenticated"]
            .clone()
    };
    assert_eq!(signin("42", 'c'), true);
    assert_eq!(signin("43", 'd'), false);
    let session = |hash: char| {
        at(
            &db,
            2001,
            json!({"op":"session","session_hash":hash.to_string().repeat(64)}),
        )
        .unwrap()["authenticated"]
            .clone()
    };
    assert_eq!((session('c'), session('d')), (json!(true), json!(false)));
    // No password: a password login is a plain refusal, never an error about a missing salt.
    let login = at(
        &db,
        2002,
        json!({"op":"login","password":"a long test password","session_hash":"e".repeat(64)}),
    )
    .unwrap();
    assert_eq!(login["authenticated"], false);
    let recover = at(&db, 2003, json!({"op":"recover","recovery_hash":"0".repeat(64),"password":"a long test password","salt":"01".repeat(16),"new_recovery_hash":"f".repeat(64)})).unwrap();
    assert_eq!(recover["authenticated"], false);
    // A second signup of the same name is refused.
    let again = with(
        github("99"),
        json!({"op":"identity_signup","username":"octocat","session_hash":"b".repeat(64)}),
    );
    assert_eq!(at(&db, 2004, again).unwrap_err().code, "ALREADY_EXISTS");
}

#[test]
fn the_last_way_to_sign_in_is_never_unlinked() {
    let db = oauth_account();
    let unlink = |provider: &str| {
        at(
            &db,
            3000,
            json!({"op":"identity_unlink","provider":provider}),
        )
    };
    assert_eq!(unlink("github").unwrap_err().code, "LAST_SIGNIN_METHOD");
    let google = json!({"op":"identity_link","provider":"google","subject":"g-1","login":"octo","email":"octo@example.com","session_hash":"a".repeat(64)});
    assert_eq!(at(&db, 3001, google).unwrap()["linked"], true);
    let listed = at(&db, 3002, json!({"op":"identity_list"})).unwrap();
    assert_eq!(listed["password"], false);
    assert_eq!(listed["identities"].as_array().unwrap().len(), 2);
    let removed = unlink("github").unwrap();
    // Google still carries the email, so its claim stays.
    assert_eq!(
        (removed["subject"].clone(), removed["email_kept"].clone()),
        (json!("42"), json!(true))
    );
    assert_eq!(unlink("google").unwrap_err().code, "LAST_SIGNIN_METHOD");
}

#[test]
fn linking_needs_a_live_session_and_one_identity_per_provider() {
    let db = oauth_account();
    let link = |subject: &str, session: char| {
        at(
            &db,
            4000,
            json!({"op":"identity_link","provider":"google","subject":subject,"login":"o","session_hash":session.to_string().repeat(64)}),
        )
    };
    assert_eq!(link("g-1", 'f').unwrap_err().code, "UNAUTHORIZED");
    assert_eq!(link("g-1", 'a').unwrap()["linked"], true);
    assert_eq!(link("g-1", 'a').unwrap()["linked"], true); // idempotent
    assert_eq!(link("g-2", 'a').unwrap_err().code, "ALREADY_EXISTS");
}

#[test]
fn a_password_account_keeps_its_password_as_a_way_in_and_recovery_drops_identities() {
    let db = NativeStore::memory().unwrap();
    at(&db, 1000, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    let link = with(
        github("7"),
        json!({"op":"identity_link","session_hash":"a".repeat(64)}),
    );
    at(&db, 1001, link).unwrap();
    // The password remains: the only identity may go.
    at(
        &db,
        1002,
        json!({"op":"identity_unlink","provider":"github"}),
    )
    .unwrap();
    let link = with(
        github("7"),
        json!({"op":"identity_link","session_hash":"a".repeat(64)}),
    );
    at(&db, 1003, link).unwrap();
    at(&db, 1004, json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"a new long password","salt":"02".repeat(16),"new_recovery_hash":"c".repeat(64)})).unwrap();
    let listed = at(&db, 1005, json!({"op":"identity_list"})).unwrap();
    assert_eq!(listed["identities"], json!([]));
}

fn flow(state: char, binding: char) -> Value {
    json!({"op":"oauth_flow_put","state_hash":state.to_string().repeat(64),"provider":"github","binding_hash":binding.to_string().repeat(64),"verifier":"v".repeat(43),"nonce":"1".repeat(32),"intent":"signin","return_to":"/device?code=BCDFGHJK"})
}
fn take(db: &NativeStore, now: i64, state: char, binding: char, provider: &str) -> Value {
    at(
        db,
        now,
        json!({"op":"oauth_flow_take","state_hash":state.to_string().repeat(64),"binding_hash":binding.to_string().repeat(64),"provider":provider}),
    )
    .unwrap()
}

#[test]
fn an_attempt_is_consumed_once_by_its_own_browser_within_ten_minutes() {
    let db = NativeStore::memory().unwrap();
    at(&db, 0, flow('a', 'b')).unwrap();
    assert_eq!(
        at(&db, 1, flow('a', 'b')).unwrap_err().code,
        "ALREADY_EXISTS"
    );
    let taken = take(&db, 1000, 'a', 'b', "github");
    assert_eq!(
        (taken["status"].clone(), taken["return_to"].clone()),
        (json!("ok"), json!("/device?code=BCDFGHJK"))
    );
    assert_eq!(take(&db, 1001, 'a', 'b', "github")["status"], "unknown");
    // Another browser's binding, or another provider's callback, spends it too.
    at(&db, 0, flow('c', 'b')).unwrap();
    assert_eq!(take(&db, 1, 'c', 'e', "github")["status"], "mismatch");
    assert_eq!(take(&db, 2, 'c', 'b', "github")["status"], "unknown");
    at(&db, 0, flow('d', 'b')).unwrap();
    assert_eq!(take(&db, 1, 'd', 'b', "google")["status"], "mismatch");
    at(&db, 0, flow('e', 'b')).unwrap();
    assert_eq!(take(&db, 600_000, 'e', 'b', "github")["status"], "expired");
    // Untrusted return paths never reach storage.
    let mut offsite = flow('f', 'b');
    offsite["return_to"] = json!("//evil.example/");
    assert!(at(&db, 0, offsite).is_err());
}

#[test]
fn a_claim_names_one_account_until_released_or_replaced() {
    let db = NativeStore::memory().unwrap();
    let key = "identity:github:42";
    let claim = |account: &str, replace: bool| {
        at(
            &db,
            5,
            json!({"op":"identity_claim","key":key,"account":account,"replace":replace}),
        )
        .unwrap()
    };
    assert_eq!(claim("alice", false)["claimed"], true);
    let refused = claim("bob", false);
    assert_eq!(
        (
            refused["claimed"].clone(),
            refused["holder"]["account"].clone()
        ),
        (json!(false), json!("alice"))
    );
    assert_eq!(claim("bob", true)["claimed"], true);
    at(
        &db,
        6,
        json!({"op":"identity_claim_release","key":key,"account":"alice"}),
    )
    .unwrap();
    let got = at(&db, 7, json!({"op":"identity_claim_get","key":key})).unwrap();
    assert_eq!(got["account"], "bob");
    for bad in [
        "email:abc",
        "identity:gitlab:1",
        "identity:github:",
        "other:1",
    ] {
        assert!(at(&db, 8, json!({"op":"identity_claim_get","key":bad})).is_err());
    }
}

#[test]
fn the_identity_migration_upgrades_a_version_six_store_and_keeps_its_account() {
    let db = NativeStore::memory().unwrap();
    db.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    let previous = [
        include_str!("migrations/0001_accounts.sql"),
        include_str!("migrations/0002_account_tokens.sql"),
        include_str!("migrations/0003_orgs.sql"),
        include_str!("migrations/0004_team_ids.sql"),
        include_str!("migrations/0005_ssh_keys.sql"),
        include_str!("migrations/0006_token_origin.sql"),
    ];
    for (version, sql) in previous.iter().enumerate() {
        for statement in sql.split(';').filter(|s| !s.trim().is_empty()) {
            db.query(statement, &[]).unwrap();
        }
        db.query(
            "INSERT INTO workspace_migrations(version,digest) VALUES(?,?)",
            &[
                json!(version as i64 + 1),
                json!(yoneda_core::digest(sql.as_bytes())),
            ],
        )
        .unwrap();
    }
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES('account',?)",
        &[json!(
            json!({"username":"bob","verifier":{"salt":"0"},"created_at":1}).to_string()
        )],
    )
    .unwrap();
    let listed = at(&db, 1001, json!({"op":"identity_list"})).unwrap();
    assert_eq!(listed, json!({"identities":[],"password":true}));
    let versions = db
        .query("SELECT version FROM workspace_migrations", &[])
        .unwrap();
    assert_eq!(versions.len(), 10);
}
