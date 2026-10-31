//! Account pictures: the provider's avatar from sign-in (allow-listed hosts only, refreshed
//! on each sign-in), an uploaded picture (type sniffed from its leading bytes, at most
//! 1 MiB) that wins over it, removal falling back to the provider's, and the migration.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

const GITHUB_AVATAR: &str = "https://avatars.githubusercontent.com/u/42?v=4";
const GOOGLE_AVATAR: &str = "https://lh3.googleusercontent.com/a/ACg8ocK-photo=s96-c";
const PNG: &str = "89504e470d0a1a0a0000000d49484452";
const JPEG: &str = "ffd8ffe000104a464946000101000001";
const WEBP: &str = "52494646240000005745425056503820";

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn github_signup(db: &NativeStore, avatar: Value) -> Value {
    at(
        db,
        1000,
        json!({"op":"identity_signup","username":"octocat","session_hash":"a".repeat(64),
               "provider":"github","subject":"42","login":"octocat","email":"octo@example.com",
               "avatar_url":avatar}),
    )
    .unwrap()
}
fn get(db: &NativeStore) -> Value {
    at(db, 2000, json!({"op":"avatar_get"})).unwrap()
}
fn serve(db: &NativeStore) -> Value {
    at(db, 2000, json!({"op":"avatar_serve"})).unwrap()
}
fn upload(db: &NativeStore, head: &str, size: i64, digest: &str) -> yoneda_core::Result<Value> {
    at(
        db,
        3000,
        json!({"op":"avatar_upload","head":head,"size":size,"digest":digest}),
    )
}

#[test]
fn a_provider_avatar_from_sign_in_is_the_picture_until_one_is_uploaded() {
    let db = NativeStore::memory().unwrap();
    github_signup(&db, json!(GITHUB_AVATAR));
    let got = get(&db);
    assert_eq!(got["source"], "provider");
    let version = got["version"].as_str().unwrap().to_string();
    assert_eq!(version.len(), 12);
    assert_eq!(serve(&db), json!({"provider_url": GITHUB_AVATAR}));

    let digest = "d".repeat(64);
    let stored = upload(&db, PNG, 2048, &digest).unwrap();
    assert_eq!(stored["content_type"], "image/png");
    assert_eq!(stored["previous_key"], Value::Null);
    let key = stored["key"].as_str().unwrap().to_string();
    assert!(
        key.starts_with("avatars/") && key.ends_with(&digest),
        "{key}"
    );
    assert!(
        !key.contains("octocat"),
        "the key does not name the account"
    );
    assert_eq!(get(&db), json!({"source":"upload","version":&digest[..12]}));
    assert_eq!(
        serve(&db),
        json!({"upload":{"key":key,"content_type":"image/png","digest":digest}})
    );

    // A later sign-in refreshes the provider's URL but the upload stays the picture.
    let newer = "https://avatars.githubusercontent.com/u/42?v=5";
    at(
        &db,
        4000,
        json!({"op":"identity_signin","provider":"github","subject":"42","session_hash":"b".repeat(64),"avatar_url":newer}),
    )
    .unwrap();
    assert_eq!(get(&db)["source"], "upload");

    // Removing the upload falls back to the provider's (refreshed) picture.
    let removed = at(&db, 5000, json!({"op":"avatar_remove"})).unwrap();
    assert_eq!(removed["previous_key"], json!(key));
    assert_eq!(serve(&db), json!({"provider_url": newer}));
    assert_ne!(
        get(&db)["version"],
        json!(version),
        "a new URL is a new version"
    );
}

#[test]
fn only_the_providers_own_image_hosts_are_kept() {
    for bad in [
        json!("http://avatars.githubusercontent.com/u/42"),
        json!("https://avatars.githubusercontent.com.evil.example/u/42"),
        json!("https://avatars.githubusercontent.com@evil.example/u/42"),
        json!("https://evil.example/u/42"),
        json!("https://lh3.googleusercontent.com/a/x"), // Google's host, but a GitHub identity
        json!("https://avatars.githubusercontent.com/u/42\"onerror=x"),
        json!(format!(
            "https://avatars.githubusercontent.com/{}",
            "a".repeat(1100)
        )),
        json!(42),
    ] {
        let db = NativeStore::memory().unwrap();
        github_signup(&db, bad.clone()); // a bad picture never blocks the sign-in
        assert_eq!(get(&db), json!({"source":null,"version":null}), "{bad}");
        assert_eq!(serve(&db), json!({}), "{bad}");
    }
    let db = NativeStore::memory().unwrap();
    github_signup(&db, Value::Null);
    assert_eq!(get(&db)["source"], Value::Null);
    // A linked Google identity brings its picture; the most recently used identity wins.
    at(
        &db,
        1500,
        json!({"op":"identity_link","provider":"google","subject":"g-1","login":"octo",
               "session_hash":"a".repeat(64),"avatar_url":GOOGLE_AVATAR}),
    )
    .unwrap();
    assert_eq!(serve(&db), json!({"provider_url": GOOGLE_AVATAR}));
}

#[test]
fn an_upload_is_sniffed_from_its_leading_bytes_and_bounded() {
    let db = NativeStore::memory().unwrap();
    github_signup(&db, Value::Null);
    let digest = "e".repeat(64);
    assert_eq!(
        upload(&db, JPEG, 100, &digest).unwrap()["content_type"],
        "image/jpeg"
    );
    assert_eq!(
        upload(&db, WEBP, 1_048_576, &digest).unwrap()["content_type"],
        "image/webp"
    );
    for (head, size, digest) in [
        ("47494638396100000000000000000000", 100, "e".repeat(64)), // GIF
        ("3c737667207800000000000000000000", 100, "e".repeat(64)), // <svg
        ("3c21444f43545950452068746d6c3e00", 100, "e".repeat(64)), // <!DOCTYPE html>
        ("52494646240000004156492041000000", 100, "e".repeat(64)), // RIFF but AVI
        (PNG, 1_048_577, "e".repeat(64)),                          // over 1 MiB
        (PNG, 0, "e".repeat(64)),                                  // empty
        ("89504e47", 100, "e".repeat(64)), // head shorter than the size allows
        (PNG, 100, "E".repeat(64)),        // digest not lowercase hex
        (PNG, 100, "e".repeat(63)),
        ("zz504e470d0a1a0a0000000d49484452", 100, "e".repeat(64)), // not hex
    ] {
        let refused = upload(&db, head, size, &digest).unwrap_err();
        assert_eq!(refused.code, "INVALID_INPUT", "{head} {size}");
    }
    // The last good upload is still the picture.
    assert_eq!(serve(&db)["upload"]["content_type"], "image/webp");
    // Replacing it names the previous key for the adapter to delete.
    let next = upload(&db, PNG, 100, &"f".repeat(64)).unwrap();
    assert!(next["previous_key"].as_str().unwrap().ends_with(&digest));
}

#[test]
fn removal_is_guarded_and_without_any_picture_there_is_none() {
    let db = NativeStore::memory().unwrap();
    github_signup(&db, Value::Null);
    let digest = "a".repeat(64);
    upload(&db, PNG, 100, &digest).unwrap();
    // The adapter's rollback names the upload it made: another one stays.
    let kept = at(
        &db,
        4000,
        json!({"op":"avatar_remove","digest":"b".repeat(64)}),
    )
    .unwrap();
    assert_eq!(kept["previous_key"], Value::Null);
    assert_eq!(get(&db)["source"], "upload");
    at(&db, 4000, json!({"op":"avatar_remove","digest":digest})).unwrap();
    assert_eq!(get(&db), json!({"source":null,"version":null}));
    // Removing nothing is a no-op.
    assert_eq!(
        at(&db, 4000, json!({"op":"avatar_remove"})).unwrap()["previous_key"],
        Value::Null
    );
}

#[test]
fn an_unknown_account_or_an_organization_has_no_picture_to_serve() {
    let db = NativeStore::memory().unwrap();
    assert_eq!(
        at(&db, 1, json!({"op":"avatar_serve"})).unwrap_err().code,
        "NOT_FOUND"
    );
    assert_eq!(
        at(&db, 1, json!({"op":"avatar_get"})).unwrap_err().code,
        "NOT_FOUND"
    );
    assert_eq!(
        upload(&db, PNG, 100, &"a".repeat(64)).unwrap_err().code,
        "NOT_FOUND"
    );
}

#[test]
fn the_avatar_migration_is_fresh_repeatable_and_upgrades_a_version_eight_store() {
    // Fresh: a new store migrates to the latest version; repeating is a no-op.
    let fresh = NativeStore::memory().unwrap();
    github_signup(&fresh, json!(GITHUB_AVATAR));
    get(&fresh);
    let versions = |db: &NativeStore| {
        db.query(
            "SELECT version FROM workspace_migrations ORDER BY version",
            &[],
        )
        .unwrap()
        .len()
    };
    assert_eq!(versions(&fresh), 10);

    // Upgrade: a version-8 store with an identity keeps it, with no picture yet.
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
        include_str!("migrations/0007_identities.sql"),
        include_str!("migrations/0008_handles_repo_names.sql"),
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
            json!({"username":"octocat","verifier":null,"created_at":1}).to_string()
        )],
    )
    .unwrap();
    db.query(
        "INSERT INTO account_identities(provider,subject,login,email,created_at,last_used_at) VALUES('github','42','octocat',NULL,1,1)",
        &[],
    )
    .unwrap();
    assert_eq!(get(&db), json!({"source":null,"version":null}));
    assert_eq!(versions(&db), 10);
    // The next sign-in brings the picture.
    at(
        &db,
        4000,
        json!({"op":"identity_signin","provider":"github","subject":"42","session_hash":"b".repeat(64),"avatar_url":GITHUB_AVATAR}),
    )
    .unwrap();
    assert_eq!(serve(&db), json!({"provider_url": GITHUB_AVATAR}));
    get(&db);
    assert_eq!(versions(&db), 10);
}
