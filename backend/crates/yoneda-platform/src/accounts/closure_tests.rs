//! Deleting an account at its authority: what the plan names, every way in ended, nothing left
//! behind for whoever takes the name next, a hold refused, an org never touched.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

const SESSION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn at(db: &NativeStore, now: i64, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(now);
    execute_workspace(db, command)
}
fn signup() -> Value {
    json!({"op":"signup","username":"ada_l","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":SESSION,"email":"ada@example.com"})
}
fn signed_up() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    at(&db, 1000, signup()).unwrap();
    at(
        &db,
        1001,
        json!({"op":"identity_link","session_hash":SESSION,"provider":"github","subject":"42","login":"ada","email":"ada@github.example","avatar_url":null}),
    )
    .unwrap();
    at(
        &db,
        1002,
        json!({"op":"github_installation_put","installation":7,"login":"ada"}),
    )
    .unwrap();
    db
}
fn live(db: &NativeStore) -> bool {
    at(db, 2000, json!({"op":"account_exists"})).unwrap()["exists"] == true
}

#[test]
fn the_plan_names_all_that_lives_elsewhere_and_how_old_the_session_is() {
    let db = signed_up();
    let plan = at(
        &db,
        61_000,
        json!({"op":"account_closure_plan","session_hash":SESSION}),
    )
    .unwrap();
    assert_eq!(plan["username"], "ada_l");
    assert_eq!(plan["handle"], "ada_l");
    assert_eq!(plan["email"], "ada@example.com");
    assert_eq!(plan["identities"][0]["subject"], "42");
    assert_eq!(plan["identities"][0]["email"], "ada@github.example");
    assert_eq!(plan["installation"], 7);
    assert_eq!(plan["session_age_ms"], 60_000);
    let elsewhere = at(&db, 3000, json!({"op":"account_closure_plan"})).unwrap();
    assert_eq!(elsewhere["session_age_ms"], Value::Null);
}

#[test]
fn ending_credentials_ends_sessions_and_leaves_the_account_to_sign_in_and_finish() {
    let db = signed_up();
    at(&db, 3000, json!({"op":"account_credentials_end"})).unwrap();
    let session = at(&db, 3001, json!({"op":"session","session_hash":SESSION})).unwrap();
    assert_eq!(session["authenticated"], false);
    assert!(live(&db));
    let plan = at(&db, 3002, json!({"op":"account_closure_plan"})).unwrap();
    assert_eq!(plan["identities"][0]["subject"], "42");
    at(&db, 3003, json!({"op":"account_credentials_end"})).unwrap();
}

#[test]
fn closing_leaves_nothing_and_a_new_account_takes_the_name_clean() {
    let db = signed_up();
    assert_eq!(
        at(&db, 3000, json!({"op":"account_close"})).unwrap()["closed"],
        true
    );
    assert!(!live(&db));
    assert_eq!(
        at(&db, 3001, json!({"op":"account_close"})).unwrap()["closed"],
        false
    );
    for table in [
        "workspace_records",
        "workspace_events",
        "account_identities",
        "account_github_installation",
    ] {
        let rows = db
            .query(&format!("SELECT COUNT(*) AS n FROM {table}"), &[])
            .unwrap();
        assert_eq!(rows[0]["n"], 0, "{table}");
    }
    at(&db, 4000, signup()).unwrap();
    assert!(live(&db));
    let plan = at(&db, 4001, json!({"op":"account_closure_plan"})).unwrap();
    assert_eq!(plan["identities"], json!([]));
    assert_eq!(plan["installation"], Value::Null);
}

#[test]
fn a_legal_hold_refuses_the_last_step() {
    let db = signed_up();
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES('legal_hold','{\"held\":true}')",
        &[],
    )
    .unwrap();
    let refused = at(&db, 3000, json!({"op":"account_close"})).unwrap_err();
    assert_eq!(refused.code, "LEGAL_HOLD");
    assert!(live(&db));
    let off = json!({"op":"account_close","_hold":"off"});
    assert_eq!(at(&db, 3001, off).unwrap()["closed"], true);
}

#[test]
fn an_org_is_never_closed_here() {
    let db = NativeStore::memory().unwrap();
    at(&db, 1, json!({"op":"account_exists"})).unwrap();
    db.query(
        "INSERT INTO workspace_records(id,payload) VALUES('account','{\"kind\":\"org\",\"username\":\"acme\"}')",
        &[],
    )
    .unwrap();
    assert_eq!(
        at(&db, 2, json!({"op":"account_close"})).unwrap()["closed"],
        false
    );
    let rows = db
        .query("SELECT COUNT(*) AS n FROM workspace_records", &[])
        .unwrap();
    assert_eq!(rows[0]["n"], 1);
}
