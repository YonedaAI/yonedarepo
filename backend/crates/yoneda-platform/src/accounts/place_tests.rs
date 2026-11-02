//! Where an account lives: its region, and the other cells holding its repositories. Both
//! come back with the checks every request already makes, so a request learns them with no
//! read of its own, and an account with neither answers exactly as before.
use super::execute_workspace;
use crate::native::NativeStore;
use serde_json::{Value, json};

fn at(db: &NativeStore, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(1000);
    execute_workspace(db, command)
}
fn account(region: Option<&str>) -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let mut signup = json!({"op":"signup","username":"alice","password":"a long test password","salt":"01".repeat(16),"recovery_hash":"b".repeat(64),"session_hash":"a".repeat(64)});
    if let Some(region) = region {
        signup["region"] = json!(region);
    }
    at(&db, signup).unwrap();
    db
}
fn session(db: &NativeStore) -> Value {
    at(db, json!({"op":"session","session_hash":"a".repeat(64)})).unwrap()
}
fn note(db: &NativeStore, cell: &str) -> yoneda_core::Result<Value> {
    at(db, json!({"op":"account_place_note","cell":cell}))
}

#[test]
fn an_account_without_a_place_answers_as_before() {
    let db = account(None);
    let answer = session(&db);
    assert!(answer.get("region").is_none());
    assert!(answer.get("cells").is_none());
}

#[test]
fn a_session_names_the_region_and_the_cells_noted() {
    let db = account(Some("weur"));
    assert_eq!(session(&db)["region"], "weur");
    assert!(session(&db).get("cells").is_none());
    note(&db, "enam").unwrap();
    note(&db, "enam").unwrap();
    assert_eq!(session(&db)["cells"], json!(["enam"]));
}

#[test]
fn a_login_names_the_region_only_to_an_adapter_that_asks() {
    let db = account(Some("weur"));
    let login =
        json!({"op":"login","password":"a long test password","session_hash":"c".repeat(64)});
    assert!(at(&db, login.clone()).unwrap().get("region").is_none());
    let mut asked = login;
    asked["place"] = json!(true);
    assert_eq!(at(&db, asked).unwrap()["region"], "weur");
}

#[test]
fn a_token_check_names_them_too() {
    let db = account(Some("weur"));
    note(&db, "enam").unwrap();
    at(
        &db,
        json!({"op":"pat_create","id":"pat_0123456789abcdef","name":"t","token_hash":"d".repeat(64),
               "scopes":["repo:read"],"repos":null,"org":null,"expires_days":30}),
    )
    .unwrap();
    let checked = at(&db, json!({"op":"pat_check","token_hash":"d".repeat(64)})).unwrap();
    assert_eq!(checked["region"], "weur");
    assert_eq!(checked["cells"], json!(["enam"]));
}

#[test]
fn an_org_keeps_its_creators_region_and_names_it_with_access() {
    let db = NativeStore::memory().unwrap();
    at(
        &db,
        json!({"op":"org_create","org":"acme","actor":"alice","region":"weur"}),
    )
    .unwrap();
    note(&db, "enam").unwrap();
    let access = at(&db, json!({"op":"org_access","account":"alice"})).unwrap();
    assert_eq!(access["region"], "weur");
    assert_eq!(access["cells"], json!(["enam"]));
}

#[test]
fn the_place_of_anyone_is_readable_and_of_nobody_is_empty() {
    let db = account(Some("weur"));
    note(&db, "enam").unwrap();
    let place = at(&db, json!({"op":"account_place"})).unwrap();
    assert_eq!(place, json!({"region":"weur","cells":["enam"]}));
    let empty = NativeStore::memory().unwrap();
    let place = at(&empty, json!({"op":"account_place"})).unwrap();
    assert_eq!(place, json!({"region":"enam","cells":[]}));
}

#[test]
fn a_cell_that_is_no_code_is_refused() {
    let db = account(None);
    assert_eq!(note(&db, "mars").unwrap_err().code, "INVALID_INPUT");
}
