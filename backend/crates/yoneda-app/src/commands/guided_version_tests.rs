//! Profile versions: a session keeps the starter version its project was created with.
use super::*;

/// A guided repository whose verified project marker records `version`.
fn versioned(version: Value) -> NativeStore {
    let db = fixture();
    let mut repository = repo(&db).unwrap();
    repository["guided_project"] = json!({"profile_id":"task-board-v1","version":version});
    save(&db, "repository", "repo", &repository).unwrap();
    db
}

#[test]
fn guided_version_two_project_pins_session_and_run_bindings() {
    let db = versioned(json!(2));
    let started = execute(&db, request("build")).unwrap();
    assert_eq!(started["version"], 2);
    let rid = started["steps"][0]["run_ids"][0].as_str().unwrap();
    assert_eq!(get(&db, "runs", rid).unwrap()["guided"]["version"], 2);
    // The evaluator report path accepts the version 2 binding end to end.
    evidence_fixture::checked(&db, rid, "build", true);
    assert_eq!(read(&db)["steps"][0]["status"], "complete");
    assert_eq!(read(&db)["version"], 2);
}

#[test]
fn guided_version_one_stays_pinned_with_or_without_a_project_marker() {
    for db in [fixture(), versioned(json!(1))] {
        let started = execute(&db, request("build")).unwrap();
        assert_eq!(started["version"], 1);
        let rid = started["steps"][0]["run_ids"][0].as_str().unwrap();
        assert_eq!(get(&db, "runs", rid).unwrap()["guided"]["version"], 1);
    }
}

#[test]
fn guided_version_mismatch_is_rejected_without_partial_state() {
    let db = versioned(json!(2));
    let before = execute(&db, json!({"op":"snapshot"})).unwrap();
    let mut stale = request("build");
    stale["version"] = json!(1);
    assert_eq!(
        execute(&db, stale).unwrap_err().code,
        "GUIDED_VERSION_MISMATCH"
    );
    let mut unknown = request("build");
    unknown["version"] = json!(3);
    assert_eq!(execute(&db, unknown).unwrap_err().code, "INVALID_INPUT");
    assert_eq!(execute(&db, json!({"op":"snapshot"})).unwrap(), before);

    // A recorded version 1 session never silently adopts another version's briefs or proofs.
    let db = versioned(json!(1));
    execute(&db, request("build")).unwrap();
    let mut repository = repo(&db).unwrap();
    repository["guided_project"]["version"] = json!(2);
    save(&db, "repository", "repo", &repository).unwrap();
    let read = execute(
        &db,
        json!({"op":"guided_session","_workspace":"owner","id":"guide-session:demo"}),
    );
    assert_eq!(read.unwrap_err().code, "GUIDED_VERSION_MISMATCH");

    let db = versioned(json!(3));
    assert_eq!(
        execute(&db, request("build")).unwrap_err().code,
        "GUIDED_VERSION_MISMATCH"
    );
}
