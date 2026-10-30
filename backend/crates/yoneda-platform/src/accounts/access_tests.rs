//! Operator access: the account summary the admin index reads, and suspension, which
//! refuses the account's sessions, password and provider sign-in, personal access tokens
//! and SSH keys until it is lifted (each credential then works again).
use super::execute_workspace;
use crate::native::NativeStore;
use serde_json::{Value, json};

const ED25519: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH test@ed25519";

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn account(email: Option<&str>) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let mut signup = json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)});
    if let Some(email) = email {
        signup["email"] = json!(email);
    }
    at(&db, 1000, signup).unwrap();
    db
}
fn session(db: &NativeStore, now: i64) -> Value {
    at(
        db,
        now,
        json!({"op":"session","session_hash":"a".repeat(64)}),
    )
    .unwrap()
}

#[test]
fn the_summary_names_creation_email_providers_handle_and_suspension() {
    let db = account(Some("alice@example.com"));
    let summary = at(&db, 2000, json!({"op":"account_summary"})).unwrap();
    assert_eq!(summary["username"], "alice");
    assert_eq!(summary["created_at"], 1000);
    assert_eq!(summary["email"], "alice@example.com");
    assert_eq!(summary["handle"], "alice");
    assert_eq!(summary["providers"], json!([]));
    assert_eq!(summary["password"], true);
    assert_eq!(summary["orgs"], json!([]));
    assert_eq!(summary["suspended_at"], Value::Null);
    // No account here: NOT_FOUND, as every account read answers.
    let empty = NativeStore::memory().unwrap();
    let e = at(&empty, 2000, json!({"op":"account_summary"})).unwrap_err();
    assert_eq!(e.code, "NOT_FOUND");
}

#[test]
fn suspension_refuses_every_credential_until_lifted() {
    let db = account(None);
    at(&db, 1500, json!({"op":"pat_create","id":"pat_0123456789abcdef","name":"ci","token_hash":"c".repeat(64),"scopes":["repo:read"],"expires_days":30,"repos":null})).unwrap();
    at(
        &db,
        1500,
        json!({"op":"ssh_key_add","id":"ssh_0123456789abcdef","title":"laptop","public_key":ED25519}),
    )
    .unwrap();
    let suspended = at(&db, 2000, json!({"op":"account_suspend"})).unwrap();
    assert_eq!(suspended["suspended_at"], 2000);
    // Repeating keeps the first time.
    assert_eq!(
        at(&db, 2500, json!({"op":"account_suspend"})).unwrap()["suspended_at"],
        2000
    );
    let refused = session(&db, 3000);
    assert_eq!(refused["authenticated"], false);
    assert_eq!(refused["suspended"], true);
    let login = at(
        &db,
        3000,
        json!({"op":"login","password":"a long test password","session_hash":"d".repeat(64)}),
    )
    .unwrap();
    assert_eq!(
        (&login["authenticated"], &login["suspended"]),
        (&json!(false), &json!(true))
    );
    // A token and a key are refused with their own code, never as revoked (the token's
    // lookup row must survive for the unsuspension).
    let pat = at(
        &db,
        3000,
        json!({"op":"pat_check","token_hash":"c".repeat(64)}),
    )
    .unwrap_err();
    assert_eq!(pat.code, "ACCOUNT_SUSPENDED");
    let key = at(
        &db,
        3000,
        json!({"op":"ssh_key_check","id":"ssh_0123456789abcdef"}),
    )
    .unwrap_err();
    assert_eq!(key.code, "ACCOUNT_SUSPENDED");
    assert_eq!(
        at(&db, 3000, json!({"op":"account_summary"})).unwrap()["suspended_at"],
        2000
    );

    let lifted = at(&db, 4000, json!({"op":"account_unsuspend"})).unwrap();
    assert_eq!(lifted["suspended_at"], Value::Null);
    assert_eq!(session(&db, 4000)["authenticated"], true);
    at(
        &db,
        4000,
        json!({"op":"pat_check","token_hash":"c".repeat(64)}),
    )
    .unwrap();
    at(
        &db,
        4000,
        json!({"op":"ssh_key_check","id":"ssh_0123456789abcdef"}),
    )
    .unwrap();
}

#[test]
fn only_an_existing_account_is_suspended() {
    let db = NativeStore::memory().unwrap();
    let e = at(&db, 2000, json!({"op":"account_suspend"})).unwrap_err();
    assert_eq!(e.code, "NOT_FOUND");
}
