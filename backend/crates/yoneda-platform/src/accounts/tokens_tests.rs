//! Personal access tokens and device-login codes held by the account authority, and the
//! forward-only workspace schema migration that adds them.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

const DAY: i64 = 24 * 60 * 60 * 1000;

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn account() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(&db, 1000, json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)})).unwrap();
    db
}
fn create(db: &NativeStore, now: i64, id: &str, hash: char, scopes: Value) -> Value {
    at(db, now, json!({"op":"pat_create","id":id,"name":"laptop","token_hash":hash.to_string().repeat(64),"scopes":scopes,"expires_days":30,"repos":null})).unwrap()
}
fn check(db: &NativeStore, now: i64, hash: char) -> yoneda_core::Result<Value> {
    at(
        db,
        now,
        json!({"op":"pat_check","token_hash":hash.to_string().repeat(64)}),
    )
}

#[test]
fn workspace_schema_migrates_fresh_repeat_and_from_version_one() {
    let fresh = account();
    let versions = |db: &NativeStore| {
        db.query(
            "SELECT version FROM workspace_migrations ORDER BY version",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r["version"].as_i64().unwrap())
        .collect::<Vec<_>>()
    };
    assert_eq!(versions(&fresh), vec![1, 2, 3, 4]);
    // Repeat application is a no-op.
    at(&fresh, 2000, json!({"op":"pat_list"})).unwrap();
    assert_eq!(versions(&fresh), vec![1, 2, 3, 4]);

    // A store at version 1 (accounts only) upgrades in place and keeps its account.
    let old = NativeStore::memory().unwrap();
    let v1 = include_str!("migrations/0001_accounts.sql");
    old.query(
        "CREATE TABLE workspace_migrations(version INTEGER PRIMARY KEY,digest TEXT NOT NULL)",
        &[],
    )
    .unwrap();
    for sql in v1.split(';').filter(|s| !s.trim().is_empty()) {
        old.query(sql, &[]).unwrap();
    }
    old.query(
        "INSERT INTO workspace_migrations(version,digest) VALUES(1,?)",
        &[json!(yoneda_core::digest(v1.as_bytes()))],
    )
    .unwrap();
    old.query(
        "INSERT INTO workspace_records(id,payload) VALUES('account',?)",
        &[json!(json!({"username":"bob","created_at":1}).to_string())],
    )
    .unwrap();
    assert_eq!(
        at(&old, 3000, json!({"op":"pat_list"})).unwrap()["tokens"],
        json!([])
    );
    assert_eq!(versions(&old), vec![1, 2, 3, 4]);

    // An applied migration that differs from the committed one is refused.
    old.query(
        "UPDATE workspace_migrations SET digest='changed' WHERE version=2",
        &[],
    )
    .unwrap();
    assert_eq!(
        at(&old, 4000, json!({"op":"pat_list"})).unwrap_err().code,
        "MIGRATION_DRIFT"
    );
}

#[test]
fn personal_tokens_are_hashed_listed_checked_expired_and_revoked() {
    let db = account();
    let created = create(
        &db,
        1000,
        "pat_0123456789abcdef",
        'c',
        json!(["repo:read", "repo:write"]),
    );
    assert_eq!(created["expires_at"], 1000 + 30 * DAY);
    assert!(created.get("token_hash").is_none());
    let listed = at(&db, 1000, json!({"op":"pat_list"})).unwrap();
    assert_eq!(listed["tokens"][0]["id"], "pat_0123456789abcdef");
    assert_eq!(
        listed["tokens"][0]["scopes"],
        json!(["repo:read", "repo:write"])
    );
    assert!(!listed.to_string().contains(&"c".repeat(64)));

    let checked = check(&db, 2000, 'c').unwrap();
    assert_eq!(checked["id"], "pat_0123456789abcdef");
    assert_eq!(checked["repos"], Value::Null);
    let listed = at(&db, 2000, json!({"op":"pat_list"})).unwrap();
    assert_eq!(listed["tokens"][0]["last_used_at"], 2000);
    assert_eq!(check(&db, 2000, 'd').unwrap_err().code, "UNAUTHORIZED");
    // Expired at its expiry instant.
    assert_eq!(
        check(&db, 1000 + 30 * DAY, 'c').unwrap_err().code,
        "UNAUTHORIZED"
    );

    create(
        &db,
        1000,
        "pat_fedcba9876543210",
        'e',
        json!(["repo:admin"]),
    );
    at(
        &db,
        3000,
        json!({"op":"pat_revoke","id":"pat_fedcba9876543210"}),
    )
    .unwrap();
    assert_eq!(check(&db, 3001, 'e').unwrap_err().code, "UNAUTHORIZED");
    let ids: Vec<Value> = at(&db, 3001, json!({"op":"pat_list"})).unwrap()["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(ids, vec![json!("pat_0123456789abcdef")]);
    assert_eq!(
        at(
            &db,
            3001,
            json!({"op":"pat_revoke","id":"pat_unknown00000000"})
        )
        .unwrap_err()
        .code,
        "NOT_FOUND"
    );
}

#[test]
fn personal_token_requests_are_validated() {
    let db = account();
    let base = json!({"op":"pat_create","id":"pat_0123456789abcdef","name":"ci","token_hash":"c".repeat(64),"scopes":["repo:read"],"expires_days":30,"repos":null});
    let refused = |patch: Value| {
        let mut command = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            command[k] = v.clone();
        }
        at(&db, 1000, command).unwrap_err().code
    };
    assert_eq!(refused(json!({"scopes":[]})), "INVALID_INPUT");
    assert_eq!(
        refused(json!({"scopes":["repo:everything"]})),
        "INVALID_INPUT"
    );
    assert_eq!(refused(json!({"expires_days":0})), "INVALID_INPUT");
    assert_eq!(refused(json!({"expires_days":91})), "INVALID_INPUT");
    assert_eq!(refused(json!({"repos":["not-a-repo"]})), "INVALID_INPUT");
    assert_eq!(refused(json!({"repos":[]})), "INVALID_INPUT");
    assert_eq!(refused(json!({"name":""})), "INVALID_INPUT");
    let mut ok = base.clone();
    ok["repos"] = json!(["r0123456789abcdef0123"]);
    ok["expires_days"] = json!(90);
    let created = at(&db, 1000, ok).unwrap();
    assert_eq!(created["repos"], json!(["r0123456789abcdef0123"]));
    // No account here: tokens belong to accounts.
    let empty = NativeStore::memory().unwrap();
    assert_eq!(at(&empty, 1000, base).unwrap_err().code, "NOT_FOUND");
}

#[test]
fn account_recovery_revokes_personal_tokens() {
    let db = account();
    create(&db, 1000, "pat_0123456789abcdef", 'c', json!(["repo:read"]));
    at(&db,2000,json!({"op":"recover","recovery_hash":"b".repeat(64),"password":"new long test password","salt":"02".repeat(16),"new_recovery_hash":"d".repeat(64)})).unwrap();
    assert_eq!(check(&db, 2001, 'c').unwrap_err().code, "UNAUTHORIZED");
}

fn device(db: &NativeStore, now: i64, op: &str, extra: Value) -> Value {
    let mut command = json!({"op":op,"user_code":"BCDFGHJK"});
    for (k, v) in extra.as_object().unwrap() {
        command[k] = v.clone();
    }
    at(db, now, command).unwrap()
}
fn poll(db: &NativeStore, now: i64) -> Value {
    device(
        db,
        now,
        "device_poll",
        json!({"secret_hash":"f".repeat(64)}),
    )
}

#[test]
fn device_codes_go_pending_slow_down_approved_once() {
    let db = NativeStore::memory().unwrap();
    let created = device(
        &db,
        0,
        "device_create",
        json!({"secret_hash":"f".repeat(64),"client_name":"yoneda cli"}),
    );
    assert_eq!(created["expires_at"], 600_000);
    assert_eq!(created["interval"], 5);
    // A code still live cannot be issued again.
    let mut again = json!({"op":"device_create","user_code":"BCDFGHJK","secret_hash":"e".repeat(64),"client_name":"x","now":1});
    assert_eq!(
        execute_workspace(&db, again.take()).unwrap_err().code,
        "ALREADY_EXISTS"
    );

    assert_eq!(poll(&db, 5_000)["status"], "AUTHORIZATION_PENDING");
    // Faster than the interval: slow down, and the interval grows by five seconds.
    let slow = poll(&db, 6_000);
    assert_eq!(slow["status"], "SLOW_DOWN");
    assert_eq!(slow["interval"], 10);
    assert_eq!(poll(&db, 16_000)["status"], "AUTHORIZATION_PENDING");
    // The wrong secret learns nothing.
    assert_eq!(
        device(
            &db,
            30_000,
            "device_poll",
            json!({"secret_hash":"0".repeat(64)})
        )["status"],
        "EXPIRED_TOKEN"
    );

    let approved = device(
        &db,
        20_000,
        "device_approve",
        json!({"account":"alice","scopes":["repo:read","repo:write"],"expires_days":7,"repos":null,"deny":false}),
    );
    assert_eq!(approved["approved"], true);
    // Approving twice is refused: the code is no longer pending.
    let mut twice = json!({"op":"device_approve","user_code":"BCDFGHJK","account":"mallory","scopes":["repo:admin"],"expires_days":7,"repos":null,"deny":false,"now":20_001});
    assert_eq!(
        execute_workspace(&db, twice.take()).unwrap_err().code,
        "NOT_FOUND"
    );

    let granted = poll(&db, 40_000);
    assert_eq!(granted["status"], "APPROVED");
    assert_eq!(granted["account"], "alice");
    assert_eq!(
        granted["grant"]["scopes"],
        json!(["repo:read", "repo:write"])
    );
    assert_eq!(granted["grant"]["expires_days"], 7);
    // Single use.
    assert_eq!(poll(&db, 60_000)["status"], "EXPIRED_TOKEN");
}

#[test]
fn device_codes_deny_and_expire() {
    let db = NativeStore::memory().unwrap();
    device(
        &db,
        0,
        "device_create",
        json!({"secret_hash":"f".repeat(64),"client_name":"cli"}),
    );
    device(
        &db,
        1_000,
        "device_approve",
        json!({"account":"alice","scopes":["repo:read"],"expires_days":30,"repos":null,"deny":true}),
    );
    assert_eq!(poll(&db, 10_000)["status"], "ACCESS_DENIED");
    assert_eq!(poll(&db, 20_000)["status"], "EXPIRED_TOKEN");

    // Expired after ten minutes, and approval of an expired code is refused.
    let db = NativeStore::memory().unwrap();
    device(
        &db,
        0,
        "device_create",
        json!({"secret_hash":"f".repeat(64),"client_name":"cli"}),
    );
    let mut late = json!({"op":"device_approve","user_code":"BCDFGHJK","account":"alice","scopes":["repo:read"],"expires_days":30,"repos":null,"deny":false,"now":600_000});
    assert_eq!(
        execute_workspace(&db, late.take()).unwrap_err().code,
        "EXPIRED_TOKEN"
    );
    assert_eq!(poll(&db, 600_001)["status"], "EXPIRED_TOKEN");
    // Once expired, the user code may be issued again.
    let renewed = device(
        &db,
        600_002,
        "device_create",
        json!({"secret_hash":"e".repeat(64),"client_name":"cli"}),
    );
    assert_eq!(renewed["expires_at"], 1_200_002);
    // Approval scopes are validated like tokens.
    let mut bad = json!({"op":"device_approve","user_code":"BCDFGHJK","account":"alice","scopes":["root"],"expires_days":30,"repos":null,"deny":false,"now":600_003});
    assert_eq!(
        execute_workspace(&db, bad.take()).unwrap_err().code,
        "INVALID_INPUT"
    );
}
