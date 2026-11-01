//! The search directory: "maybe" unless a current summary says no, and no way to get a summary,
//! or a list of what it holds, back out.
use super::execute_workspace;
use crate::native::NativeStore;
use serde_json::{Value, json};
use yoneda_core::search::summary::{SUMMARY_BITS, Summary};

const A: &str = "r00000000000000000001";
const B: &str = "r00000000000000000002";

fn run(db: &NativeStore, mut command: Value) -> yoneda_core::Result<Value> {
    command["now"] = json!(5000);
    execute_workspace(db, command)
}
fn directory() -> NativeStore {
    NativeStore::memory().unwrap()
}
fn bits_of(text: &str) -> String {
    let mut summary = Summary::default();
    summary.add_path(text);
    summary.to_hex()
}
fn put(db: &NativeStore, repo: &str, at: i64, text: &str) -> Value {
    run(
        db,
        json!({"op":"search_put","repo":repo,"at":at,"commit":"c1","bits":bits_of(text)}),
    )
    .unwrap()
}
fn maybe(db: &NativeStore, repos: Value, query: &str) -> Vec<String> {
    let found = run(db, json!({"op":"search_match","repos":repos,"query":query})).unwrap();
    let mut ids: Vec<String> = found["maybe"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}
fn one(repo: &str, at: i64) -> Value {
    json!([{"id": repo, "at": at}])
}

#[test]
fn a_current_summary_rules_out_a_query_it_cannot_hold() {
    let db = directory();
    put(&db, A, 1000, "contains needle here");
    put(&db, B, 1000, "something else entirely");
    let both = json!([{"id":A,"at":900},{"id":B,"at":900}]);
    assert_eq!(maybe(&db, both, "needle"), [A]);
}

#[test]
fn no_row_is_maybe() {
    assert_eq!(maybe(&directory(), one(A, 0), "needle"), [A]);
}

#[test]
fn activity_newer_than_the_summary_is_maybe() {
    let db = directory();
    put(&db, A, 1000, "nothing relevant");
    assert!(maybe(&db, one(A, 1000), "needle").is_empty());
    assert_eq!(maybe(&db, one(A, 1001), "needle"), [A]);
}

#[test]
fn a_saturated_row_is_maybe() {
    let db = directory();
    run(
        &db,
        json!({"op":"search_put","repo":A,"at":1000,"commit":"c1","saturated":true}),
    )
    .unwrap();
    assert_eq!(maybe(&db, one(A, 0), "needle"), [A]);
}

#[test]
fn a_row_of_another_version_is_maybe() {
    let db = directory();
    put(&db, A, 1000, "nothing relevant");
    use crate::storage::SqlStore;
    db.query(
        "UPDATE workspace_records SET payload=json_set(payload,'$.v',99)",
        &[],
    )
    .unwrap();
    assert_eq!(maybe(&db, one(A, 0), "needle"), [A]);
}

#[test]
fn a_query_without_a_trigram_is_maybe_everywhere() {
    let db = directory();
    put(&db, A, 1000, "nothing relevant");
    assert_eq!(maybe(&db, one(A, 0), "zq"), [A]);
}

#[test]
fn an_unchanged_fork_is_left_out_until_it_has_activity() {
    let db = directory();
    run(&db, json!({"op":"search_fork","repo":A,"at":1000})).unwrap();
    assert!(maybe(&db, one(A, 1000), "needle").is_empty());
    assert_eq!(maybe(&db, one(A, 1001), "needle"), [A]);
    // Its first summary replaces the marker.
    put(&db, A, 2000, "needle");
    assert_eq!(maybe(&db, one(A, 0), "needle"), [A]);
    assert!(maybe(&db, one(A, 0), "absent").is_empty());
}

#[test]
fn a_late_job_cannot_replace_a_newer_row() {
    let db = directory();
    assert_eq!(put(&db, A, 2000, "newer")["stored"], true);
    assert_eq!(put(&db, A, 1000, "older needle")["stored"], false);
    assert!(maybe(&db, one(A, 0), "needle").is_empty());
}

#[test]
fn voiding_stops_earlier_reads_coming_back() {
    let db = directory();
    put(&db, A, 1000, "nothing relevant");
    run(&db, json!({"op":"search_void","repo":A})).unwrap();
    assert_eq!(maybe(&db, one(A, 0), "needle"), [A]);
    // Read before the void (now is 5000): refused. Read after it: stored.
    assert_eq!(put(&db, A, 4000, "nothing")["stored"], false);
    assert_eq!(put(&db, A, 6000, "nothing")["stored"], true);
    assert!(maybe(&db, one(A, 0), "needle").is_empty());
}

#[test]
fn dropping_leaves_no_row() {
    let db = directory();
    put(&db, A, 1000, "nothing relevant");
    run(&db, json!({"op":"search_drop","repo":A})).unwrap();
    use crate::storage::SqlStore;
    assert!(
        db.query("SELECT id FROM workspace_records", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(maybe(&db, one(A, 0), "needle"), [A]);
}

#[test]
fn a_touch_keeps_a_summary_of_the_same_commit_current() {
    let db = directory();
    put(&db, A, 1000, "nothing relevant");
    let touch = |commit, at| {
        run(
            &db,
            json!({"op":"search_touch","repo":A,"commit":commit,"at":at}),
        )
        .unwrap()["current"]
            .clone()
    };
    assert_eq!(touch("c2", 2000), false);
    assert_eq!(maybe(&db, one(A, 2000), "needle"), [A]);
    assert_eq!(touch("c1", 2000), true);
    assert!(maybe(&db, one(A, 2000), "needle").is_empty());
    // It never moves back.
    assert_eq!(touch("c1", 500), true);
    assert!(maybe(&db, one(A, 2000), "needle").is_empty());
}

#[test]
fn it_takes_ids_only_and_never_returns_bits() {
    let db = directory();
    put(&db, A, 1000, "needle");
    let answer = run(
        &db,
        json!({"op":"search_match","repos":one(A, 0),"query":"needle"}),
    )
    .unwrap();
    assert_eq!(answer, json!({ "maybe": [A] }));
    let refused = |repos: Value| {
        run(
            &db,
            json!({"op":"search_match","repos":repos,"query":"needle"}),
        )
        .is_err()
    };
    assert!(refused(Value::Null));
    assert!(refused(json!([{"id":"%"}])));
    let many: Vec<Value> = (0..201)
        .map(|i| json!({"id": format!("r{i:020x}"), "at": 0}))
        .collect();
    assert!(refused(Value::Array(many)));
}

#[test]
fn a_put_is_checked() {
    let db = directory();
    let put = |extra: Value| {
        let mut command = json!({"op":"search_put","repo":A,"at":1000,"commit":"c"});
        command
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        run(&db, command).is_ok()
    };
    assert!(!put(json!({})));
    assert!(!put(json!({"bits":"00"})));
    assert!(!put(json!({"repo":"nope","saturated":true})));
    assert!(put(json!({"bits":"0".repeat((SUMMARY_BITS / 4) as usize)})));
}

#[test]
fn an_account_instance_holds_no_directory() {
    let db = directory();
    run(&db, json!({"op":"org_create","org":"acme","actor":"alice"})).unwrap();
    assert!(run(&db, json!({"op":"search_match","repos":[],"query":"abc"})).is_err());
}
