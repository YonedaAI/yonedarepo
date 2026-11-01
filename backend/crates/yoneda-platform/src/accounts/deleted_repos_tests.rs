//! An owner's list of repositories it can still restore: the source D1's copy is rebuilt from.
use super::execute_workspace;
use crate::native::NativeStore;
use serde_json::{Value, json};

const REPO: &str = "r0123456789abcdef0123";
const OTHER: &str = "rfedcba9876543210fedc";

fn ok(db: &NativeStore, mut command: Value) -> Value {
    command["now"] = json!(5000);
    execute_workspace(db, command).unwrap()
}
fn acme() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    ok(&db, json!({"op":"org_create","org":"acme","actor":"alice"}));
    db
}
fn list(db: &NativeStore) -> Value {
    ok(db, json!({"op":"deleted_repo_list"}))["repos"].clone()
}

#[test]
fn entries_are_kept_replaced_and_removed_one_repository_at_a_time() {
    let db = acme();
    assert_eq!(list(&db), json!([]));
    let entry = json!({"name":"app","purge_at":10});
    ok(
        &db,
        json!({"op":"deleted_repo_put","repo":REPO,"entry":entry}),
    );
    ok(
        &db,
        json!({"op":"deleted_repo_put","repo":OTHER,"entry":{"name":"b"}}),
    );
    ok(
        &db,
        json!({"op":"deleted_repo_put","repo":REPO,"entry":{"name":"app","purge_at":20}}),
    );
    assert_eq!(
        list(&db),
        json!([{"repo":REPO,"name":"app","purge_at":20},{"repo":OTHER,"name":"b"}])
    );
    ok(&db, json!({"op":"deleted_repo_remove","repo":REPO}));
    ok(&db, json!({"op":"deleted_repo_remove","repo":REPO}));
    assert_eq!(list(&db), json!([{"repo":OTHER,"name":"b"}]));
}

#[test]
fn only_repository_ids_and_objects_are_taken() {
    let db = acme();
    let mut bad = json!({"op":"deleted_repo_put","repo":"nope","entry":{}});
    bad["now"] = json!(1);
    assert_eq!(
        execute_workspace(&db, bad).unwrap_err().code,
        "INVALID_INPUT"
    );
    let mut bad = json!({"op":"deleted_repo_put","repo":REPO,"entry":"text"});
    bad["now"] = json!(1);
    assert_eq!(
        execute_workspace(&db, bad).unwrap_err().code,
        "INVALID_INPUT"
    );
}

#[test]
fn a_deleted_org_keeps_its_entries_until_each_is_purged() {
    let db = acme();
    ok(
        &db,
        json!({"op":"deleted_repo_put","repo":REPO,"entry":{"name":"app"}}),
    );
    ok(
        &db,
        json!({"op":"org_delete","actor":"alice","confirm":"acme","_hold":"off"}),
    );
    assert_eq!(list(&db).as_array().unwrap().len(), 1);
    ok(&db, json!({"op":"deleted_repo_remove","repo":REPO}));
    assert_eq!(list(&db), json!([]));
}
