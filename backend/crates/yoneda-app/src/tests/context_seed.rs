use super::*;
use crate::storage::get;

fn request() -> Value {
    json!({"op":"init","id":"study","name":"Study","remote":{"namespace":"yoneda-dev","name":"study"},"commit":"a".repeat(40),"policy":yoneda_core::Policy::default(),
        "context_seed":{"intent_id":"intent:study","statement":"Preserve booking behavior","records":[{"id":"context:booking:capacity","kind":"constraint","statement":"Capacity must remain positive","purpose":"Avoid overselling","verified":true}]}})
}

#[test]
fn initial_corpus_is_owner_assertions_and_dispatches_no_work() {
    let db = NativeStore::memory().unwrap();
    call(&db, request()).unwrap();
    let record = get(&db, "nodes", "context:booking:capacity").unwrap();
    assert_eq!(record["author"], "owner");
    assert_eq!(record["data"]["authority"], "assertion");
    assert!(record["data"].get("verified").is_none());
    assert_eq!(
        call(&db, json!({"op":"snapshot"})).unwrap()["runs"],
        json!([])
    );
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM jobs", &[]).unwrap()[0]["count"],
        0
    );
}

#[test]
fn invalid_seed_rolls_back_repository_and_all_preceding_context() {
    let db = NativeStore::memory().unwrap();
    let mut input = request();
    input["context_seed"]["records"].as_array_mut().unwrap().push(json!({"id":"invalid","kind":"constraint","statement":"Wrong identifier","purpose":"Invalid corpus"}));
    assert_eq!(call(&db, input).unwrap_err().code, "INVALID_INPUT");
    assert!(get(&db, "repository", "repo").is_err());
    assert!(get(&db, "nodes", "context:booking:capacity").is_err());
    assert_eq!(
        db.query("SELECT COUNT(*) AS count FROM events", &[])
            .unwrap()[0]["count"],
        0
    );
}
