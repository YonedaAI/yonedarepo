//! Legal holds in the owner's account authority: who sets and releases them, what the
//! check answers (for a repository: its own hold or its owner's), and that they stop an
//! org being deleted.
use super::execute_workspace;
use crate::{native::NativeStore, storage::SqlStore};
use serde_json::{Value, json};

const REPO: &str = "r0123456789abcdef0123";
const OTHER: &str = "rfedcba9876543210fedc";

fn at(db: &NativeStore, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(5000);
    execute_workspace(db, command)
}
fn ok(db: &NativeStore, command: Value) -> Value {
    at(db, command).unwrap()
}
fn code(db: &NativeStore, command: Value) -> String {
    at(db, command).unwrap_err().code
}
/// The `acme` org: alice created it, bob owns it too, carol is a member.
fn acme() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    ok(&db, json!({"op":"org_create","org":"acme","actor":"alice"}));
    for (account, role) in [("bob", "owner"), ("carol", "member")] {
        ok(
            &db,
            json!({"op":"org_member_put","actor":"alice","account":account,"role":role}),
        );
    }
    db
}
fn held(db: &NativeStore, repo: &str) -> bool {
    ok(db, json!({"op":"hold_check","repo":repo}))["held"] == true
}
fn events(db: &NativeStore, kind: &str) -> Vec<Value> {
    db.query(
        "SELECT data FROM workspace_events WHERE kind=? ORDER BY rowid",
        &[json!(kind)],
    )
    .unwrap()
    .iter()
    .map(|r| serde_json::from_str(r["data"].as_str().unwrap()).unwrap())
    .collect()
}

#[test]
fn an_org_hold_covers_every_repository_and_a_repo_hold_only_its_own() {
    let db = acme();
    assert!(!held(&db, REPO));
    ok(&db, json!({"op":"org_hold_set","actor":"bob","repo":REPO}));
    assert!(held(&db, REPO));
    assert!(!held(&db, OTHER));
    ok(&db, json!({"op":"org_hold_set","actor":"alice"}));
    assert!(held(&db, OTHER));
    ok(&db, json!({"op":"org_hold_release","actor":"bob"}));
    assert!(!held(&db, OTHER));
    assert!(held(&db, REPO));
    ok(
        &db,
        json!({"op":"org_hold_release","actor":"alice","repo":REPO}),
    );
    assert!(!held(&db, REPO));
}

#[test]
fn a_check_asks_nothing_of_an_account_it_does_not_know() {
    let db = NativeStore::memory().unwrap();
    let answer = ok(&db, json!({"op":"hold_check","repo":REPO}));
    assert_eq!(answer, json!({"held":false,"org":null,"repo":null}));
}

#[test]
fn only_owners_set_and_release_and_any_member_sees() {
    let db = acme();
    for op in ["org_hold_set", "org_hold_release"] {
        assert_eq!(code(&db, json!({"op":op,"actor":"carol"})), "FORBIDDEN");
        assert_eq!(code(&db, json!({"op":op,"actor":"dave"})), "FORBIDDEN");
    }
    ok(&db, json!({"op":"org_hold_set","actor":"bob"}));
    ok(&db, json!({"op":"org_hold_set","actor":"bob","repo":REPO}));
    let shown = ok(&db, json!({"op":"org_hold_show","actor":"carol"}));
    assert_eq!(shown["org"]["owner"]["by"], "user:bob");
    assert_eq!(shown["org"]["owner"]["at"], 5000);
    assert_eq!(shown["repos"][REPO]["owner"]["by"], "user:bob");
    assert_eq!(
        code(&db, json!({"op":"org_hold_show","actor":"dave"})),
        "FORBIDDEN"
    );
}

#[test]
fn personal_owners_do_not_set_holds() {
    let db = NativeStore::memory().unwrap();
    ok(
        &db,
        json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)}),
    );
    assert_eq!(
        code(&db, json!({"op":"org_hold_set","actor":"alice"})),
        "NOT_FOUND"
    );
    // An operator may, on one repository.
    ok(
        &db,
        json!({"op":"hold_operator_set","operator":"ops","repo":REPO}),
    );
    assert!(held(&db, REPO));
    assert_eq!(
        code(&db, json!({"op":"hold_operator_set","operator":"ops"})),
        "NOT_FOUND"
    );
}

#[test]
fn an_operator_hold_outlives_the_owners_release_and_only_an_operator_lifts_it() {
    let db = acme();
    ok(&db, json!({"op":"hold_operator_set","operator":"ops"}));
    assert!(held(&db, REPO));
    assert_eq!(
        code(&db, json!({"op":"org_hold_release","actor":"alice"})),
        "FORBIDDEN"
    );
    // Both may hold at once, each releasing only its own.
    ok(&db, json!({"op":"org_hold_set","actor":"alice"}));
    ok(&db, json!({"op":"org_hold_release","actor":"alice"}));
    assert!(held(&db, REPO));
    let shown = ok(&db, json!({"op":"org_hold_show","actor":"alice"}));
    assert_eq!(shown["org"], json!({"operator":{"at":5000,"by":"ops"}}));
    ok(&db, json!({"op":"hold_operator_release","operator":"ops2"}));
    assert!(!held(&db, REPO));
}

#[test]
fn an_operators_release_leaves_the_owners_hold() {
    let db = acme();
    ok(&db, json!({"op":"org_hold_set","actor":"alice"}));
    ok(&db, json!({"op":"hold_operator_set","operator":"ops"}));
    ok(&db, json!({"op":"hold_operator_release","operator":"ops"}));
    assert!(held(&db, REPO));
    assert_eq!(
        ok(&db, json!({"op":"hold_operator_release","operator":"ops"}))["released"],
        false
    );
}

#[test]
fn setting_twice_keeps_who_set_it_and_every_change_is_audited_once() {
    let db = acme();
    ok(&db, json!({"op":"org_hold_set","actor":"alice"}));
    let again = ok(&db, json!({"op":"org_hold_set","actor":"bob"}));
    assert_eq!(again["hold"]["owner"]["by"], "user:alice");
    assert_eq!(
        events(&db, "legal_hold.set"),
        [json!({"repo":null,"layer":"owner","by":"user:alice"})]
    );
    ok(&db, json!({"op":"org_hold_release","actor":"bob"}));
    assert_eq!(
        ok(&db, json!({"op":"org_hold_release","actor":"bob"}))["released"],
        false
    );
    ok(
        &db,
        json!({"op":"hold_operator_set","operator":"ops","repo":REPO}),
    );
    assert_eq!(
        events(&db, "legal_hold.released"),
        [json!({"repo":null,"layer":"owner","by":"user:bob"})]
    );
    assert_eq!(
        events(&db, "legal_hold.set").last().unwrap(),
        &json!({"repo":REPO,"layer":"operator","by":"ops"})
    );
}

#[test]
fn a_repository_id_is_checked() {
    let db = acme();
    for repo in ["", "r123", "../x", "R0123456789ABCDEF0123"] {
        assert_eq!(
            code(
                &db,
                json!({"op":"org_hold_set","actor":"alice","repo":repo})
            ),
            "INVALID_INPUT",
            "{repo}"
        );
    }
}

#[test]
fn a_hold_refuses_deleting_the_org_until_released() {
    let delete = json!({"op":"org_delete","actor":"alice","confirm":"acme"});
    let db = acme();
    ok(&db, json!({"op":"org_hold_set","actor":"bob"}));
    assert_eq!(code(&db, delete.clone()), "LEGAL_HOLD");
    ok(&db, json!({"op":"org_hold_release","actor":"bob"}));
    ok(&db, json!({"op":"org_hold_set","actor":"bob","repo":REPO}));
    assert_eq!(code(&db, delete.clone()), "LEGAL_HOLD");
    assert_eq!(
        ok(&db, json!({"op":"org_show","actor":"carol"}))["org"],
        "acme"
    );
    ok(
        &db,
        json!({"op":"org_hold_release","actor":"bob","repo":REPO}),
    );
    assert_eq!(ok(&db, delete)["deleted"], true);
}

#[test]
fn with_the_switch_off_an_old_hold_does_not_stop_a_delete() {
    let db = acme();
    ok(&db, json!({"op":"org_hold_set","actor":"bob"}));
    let delete = json!({"op":"org_delete","actor":"alice","confirm":"acme","_hold":"off"});
    assert_eq!(ok(&db, delete)["deleted"], true);
}
