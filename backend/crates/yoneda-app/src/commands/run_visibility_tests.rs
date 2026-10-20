use crate::{SqlStore, commands::source_kit::execute, native::NativeStore};
use serde_json::{Value, json};

fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(&db, json!({"op":"init","id":"repo-test","name":"Owner project","workspace":"alice","remote":{"namespace":"test","name":"private"},"commit":"a".repeat(40),"policy":yoneda_agents_core::Policy::default()})).unwrap();
    for (id, at) in [("old", 1), ("current", 2), ("older", 0)] {
        execute(
            &db,
            json!({"op":"start_run","id":id,"intent":"Inspect source","now":at}),
        )
        .unwrap();
        execute(&db, json!({"op":"cancel_run","run_id":id,"now":at+10})).unwrap();
    }
    db
}

fn visibility(id: &str, hidden: bool, expected: bool) -> Value {
    json!({"op":"run_set_visibility","_workspace":"alice","run_id":id,"hidden":hidden,"expected_hidden":expected,"reason":"Hide old demo history from normal view","now":100})
}

#[test]
fn hides_before_pagination_and_restores_without_deleting_audit_or_accounting() {
    let db = fixture();
    let before = execute(&db, json!({"op":"run_detail","run_id":"old"})).unwrap();
    let repository = execute(&db, json!({"op":"repository_status"})).unwrap();
    let hidden = execute(&db, visibility("old", true, false)).unwrap();
    assert_eq!(hidden["hidden"], true);
    let page = execute(&db, json!({"op":"runs_page","limit":1})).unwrap();
    assert_eq!(page["items"][0]["id"], "current");
    assert_eq!(page["has_more"], true);
    let next = execute(&db, json!({"op":"runs_page","limit":1,"cursor":page["next_cursor"],"watermark":page["watermark"]})).unwrap();
    assert_eq!(next["items"][0]["id"], "older");
    assert_eq!(next["has_more"], false);
    let audit = execute(
        &db,
        json!({"op":"run_detail","run_id":"old","_workspace":"alice"}),
    )
    .unwrap();
    for field in [
        "executions",
        "candidates",
        "evaluations",
        "decisions",
        "artifacts",
    ] {
        assert_eq!(audit[field], before[field]);
    }
    assert_eq!(
        execute(&db, json!({"op":"repository_status"})).unwrap(),
        repository
    );
    let full = execute(&db, json!({"op":"snapshot"})).unwrap();
    assert_eq!(full["runs"].as_array().unwrap().len(), 3);
    assert_eq!(
        execute(&db, visibility("old", false, true)).unwrap()["hidden"],
        false
    );
    assert_eq!(
        execute(&db, json!({"op":"runs_page"})).unwrap()["items"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn visibility_requires_owner_authority_and_validates_cas_without_partial_changes() {
    let db = fixture();
    for authority in [
        json!({"_workspace":"bob"}),
        json!({"_workspace":"alice","_grant":"agent"}),
        json!({"_workspace":"alice","job_id":"job:old:research"}),
    ] {
        let mut c = visibility("old", true, false);
        for (k, v) in authority.as_object().unwrap() {
            c[k] = v.clone();
        }
        assert_eq!(execute(&db, c).unwrap_err().code, "FORBIDDEN");
    }
    let mut absent = visibility("old", true, false);
    absent.as_object_mut().unwrap().remove("_workspace");
    assert_eq!(execute(&db, absent).unwrap_err().code, "FORBIDDEN");
    assert_eq!(
        execute(&db, visibility("old", true, true))
            .unwrap_err()
            .code,
        "VISIBILITY_CHANGED"
    );
    let mut invalid = visibility("old", true, false);
    invalid["hidden"] = json!("true");
    assert_eq!(execute(&db, invalid).unwrap_err().code, "INVALID_INPUT");
    assert_ne!(
        execute(&db, json!({"op":"run_detail","run_id":"old"})).unwrap()["run"]["hidden"],
        true
    );
}

#[test]
fn blocks_running_and_awaiting_jobs_even_when_run_status_is_terminal() {
    let db = fixture();
    for status in ["queued", "running", "awaiting_intent"] {
        db.query("UPDATE jobs SET payload=json_set(payload,'$.status',?) WHERE json_extract(payload,'$.payload.execution.run_id')='old'", &[json!(status)]).unwrap();
        assert_eq!(
            execute(&db, visibility("old", true, false))
                .unwrap_err()
                .code,
            "RUN_ACTIVE_WORK"
        );
    }
    db.query("UPDATE jobs SET payload=json_set(payload,'$.status','done') WHERE json_extract(payload,'$.payload.execution.run_id')='old'", &[]).unwrap();
    for status in ["capturing", "evaluating"] {
        db.query("UPDATE executions SET payload=json_set(payload,'$.status',?) WHERE json_extract(payload,'$.run_id')='old'", &[json!(status)]).unwrap();
        assert_eq!(
            execute(&db, visibility("old", true, false))
                .unwrap_err()
                .code,
            "RUN_ACTIVE_WORK"
        );
    }
    db.query("UPDATE executions SET payload=json_set(payload,'$.status','running','$.harness','external') WHERE json_extract(payload,'$.run_id')='old'", &[]).unwrap();
    assert_eq!(
        execute(&db, visibility("old", true, false))
            .unwrap_err()
            .code,
        "RUN_ACTIVE_WORK"
    );
    db.query("UPDATE executions SET payload=json_set(payload,'$.status','completed') WHERE json_extract(payload,'$.run_id')='old'", &[]).unwrap();
    db.query(
        "UPDATE runs SET payload=json_set(payload,'$.status','running') WHERE id='old'",
        &[],
    )
    .unwrap();
    assert_eq!(
        execute(&db, visibility("old", true, false))
            .unwrap_err()
            .code,
        "RUN_NOT_TERMINAL"
    );
}

#[test]
fn retains_the_current_checked_working_result_and_its_prior_context() {
    let db = fixture();
    db.query("INSERT INTO candidates(id,payload) VALUES('checked',?)", &[json!(json!({"id":"checked","run_id":"current","status":"eligible","revision":{"commit":"b".repeat(40)}}).to_string())]).unwrap();
    db.query("INSERT INTO working_branches(id,payload) VALUES('development',?)", &[json!(json!({"id":"development","status":"active","latest_candidate_id":"checked","working_commit":"b".repeat(40)}).to_string())]).unwrap();
    assert_eq!(
        execute(&db, visibility("current", true, false))
            .unwrap_err()
            .code,
        "RUN_CURRENT_RESULT"
    );
    execute(&db, visibility("old", true, false)).unwrap();
    assert_eq!(
        execute(&db, json!({"op":"candidate_record","id":"checked"})).unwrap()["revision"]["commit"],
        "b".repeat(40)
    );
    assert!(
        !execute(&db, json!({"op":"run_graph_page","run_id":"old"})).unwrap()["nodes"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn repeated_visibility_changes_do_not_duplicate_audit_events() {
    let db = fixture();
    let command = visibility("old", true, false);
    execute(&db, command.clone()).unwrap();
    assert_eq!(
        execute(&db, command).unwrap_err().code,
        "VISIBILITY_CHANGED"
    );
    execute(&db, visibility("old", true, true)).unwrap();
    assert_eq!(
        db.query(
            "SELECT COUNT(*) AS n FROM events WHERE kind='run.visibility_changed'",
            &[]
        )
        .unwrap()[0]["n"],
        1
    );
}

#[test]
fn project_preflight_reports_active_work_and_visible_history_without_changing_state() {
    let db = fixture();
    let read = || {
        execute(
            &db,
            json!({"op":"project_visibility_check","_workspace":"alice"}),
        )
        .unwrap()
    };
    assert_eq!(
        read(),
        json!({"repo_id":"repo-test","workspace":"alice","quiescent":true,"all_runs_hidden":false,"current_result":false})
    );
    for id in ["old", "current", "older"] {
        execute(&db, visibility(id, true, false)).unwrap();
    }
    assert_eq!(read()["all_runs_hidden"], true);
    db.query("UPDATE jobs SET payload=json_set(payload,'$.status','awaiting_intent') WHERE json_extract(payload,'$.payload.execution.run_id')='old'", &[]).unwrap();
    assert_eq!(read()["quiescent"], false);
}
