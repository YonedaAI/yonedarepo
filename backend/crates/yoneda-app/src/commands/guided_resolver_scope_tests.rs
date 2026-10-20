//! Resolver write scope: any valid repository path except protected verification paths.
use super::*;
use crate::commands::source_kit;
fn call(db: &NativeStore, input: Value, now: i64) -> Value {
    let mut input = input;
    input["now"] = json!(now);
    crate::commands::source_kit::approve_start(db, &mut input);
    execute(db, input).unwrap()
}
const CONFLICT: &str = "conflict:scope-conflict";
const PROTECTED: [&str; 3] = [
    "README.md",
    ".yoneda-guided",
    "fixtures/guided-task-board/oracle",
];
/// Drive a real unresolved refresh and autonomous resolver up to its claimed capture.
fn claimed_capture() -> (NativeStore, Value, Value, Value) {
    let (db, run, candidate) = stale_capture();
    let cid = candidate["id"].as_str().unwrap();
    evidence_fixture::evaluate(&db, cid, "parallel");
    lazy_source(&db, &run);
    let view = read(&db);
    let head = view["working_revision"]["commit"].clone();
    let version = view["working_version"].clone();
    let receipt = call(
        &db,
        json!({"op":"refresh_candidate","request_id":"scope-conflict","candidate_id":cid,"expected_commit":head,"expected_version":version}),
        65,
    );
    let refresh = call(&db, json!({"op":"claim","job_id":receipt["job_id"]}), 66);
    let declared = crate::path_lists::load(&db, &refresh["payload"], "declared_paths").unwrap();
    let captured = json!(["public/app.mjs", "public/tasks.mjs"]);
    let intervening = json!(["public/style.css", "public/tasks.mjs"]);
    let overlap = json!(["public/tasks.mjs"]);
    call(
        &db,
        json!({"op":"conflict_refresh_complete","job_id":refresh["id"],"epoch":refresh["epoch"],"result":{
        "status":"unresolved","evidence":{"base_commit":candidate["base"]["commit"],"observed_head":head,"candidate_commit":candidate["revision"]["commit"],"declared_paths":declared,"captured_paths":captured,"intervening_paths":intervening,"overlapping_paths":overlap},
        "merge_workspace_commit":"3".repeat(40),"merge_tree":"7".repeat(40),"workspace_revision":{"repository":"owner/merge","commit":"3".repeat(40)},"conflict_paths":overlap,
        "readback":{"observed_head":head,"version":version,"parents":[head,candidate["revision"]["commit"]],"candidate_paths":captured,"intervening_paths":intervening,"workspace_commit":"3".repeat(40),"conflict_paths":overlap,"expected_head_tree":"8".repeat(40),"merged_paths":captured}}}),
        67,
    );
    let updated = get(&db, "runs", run["id"].as_str().unwrap()).unwrap();
    let coordinator = call(
        &db,
        json!({"op":"claim","job_id":format!("job:{}",updated["coordinator_execution_id"].as_str().unwrap())}),
        68,
    );
    let resolved = call(
        &db,
        json!({"op":"resolve_conflict","job_id":coordinator["id"],"epoch":coordinator["epoch"],"request_id":"scope-resolve","conflict_id":CONFLICT,"expected_commit":head,"expected_version":version,"expected_plan_revision":updated["team_plan_revision"],"expected_task_revisions":{"core":1,"integrate":1}}),
        69,
    );
    let resolver = call(&db, json!({"op":"claim","job_id":resolved["job_id"]}), 70);
    call(
        &db,
        json!({"op":"record_transcript","job_id":resolver["id"],"epoch":resolver["epoch"],"digest":"a".repeat(64)}),
        71,
    );
    let registration = source_kit::finish_agent(&db, &resolver, 72);
    let capture = call(
        &db,
        json!({"op":"claim","job_id":format!("capture:{}",resolved["execution_id"].as_str().unwrap())}),
        73,
    );
    (
        db,
        resolver,
        capture,
        json!({"head":head,"version":version,"registration":registration}),
    )
}
fn finish(
    db: &NativeStore,
    capture: &Value,
    at: &Value,
    delta: &[&str],
) -> yoneda_agents_core::Result<Value> {
    let paths = json!([
        "public/app.mjs",
        "public/style.css",
        "public/tasks.mjs",
        "src/new.mjs"
    ]);
    let registration = &at["registration"];
    let result = source_kit::capture_result(
        registration,
        "candidate:scope-final",
        &"4".repeat(40),
        paths.clone(),
        json!({"resolver_delta_paths":delta,"readback":{"observed_head":at["head"],"version":at["version"],
            "parents":registration["binding"]["parents"],"candidate_commit":"4".repeat(40),
            "resolver_delta_paths":delta,"captured_paths":paths}}),
    );
    execute(
        db,
        json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],"now":74,"result":result}),
    )
}
#[test]
fn resolver_keeps_actual_conflicts_and_freezes_only_protected_paths() {
    let (db, resolver, capture, _) = claimed_capture();
    let record = get(&db, "conflicts", CONFLICT).unwrap();
    assert_eq!(
        crate::path_lists::load(&db, &record, "conflict_paths").unwrap(),
        ["public/tasks.mjs"]
    );
    let execution = &resolver["payload"]["execution"];
    assert_eq!(execution["conflict_paths"], json!(["public/tasks.mjs"]));
    let task = execution["task"].as_str().unwrap();
    assert!(task.contains("any repository file"), "{task}");
    assert!(task.contains(&PROTECTED.join(", ")), "{task}");
    assert!(task.contains("public/tasks.mjs"), "{task}");
    assert_eq!(
        capture["payload"]["conflict_paths"],
        json!(["public/tasks.mjs"])
    );
    assert_eq!(
        capture["payload"]["resolver_protected_paths"],
        json!(PROTECTED)
    );
}
#[test]
fn resolver_capture_accepts_edits_outside_the_conflicting_paths_and_records_them() {
    let (db, _, capture, at) = claimed_capture();
    let delta = ["public/style.css", "public/tasks.mjs", "src/new.mjs"];
    finish(&db, &capture, &at, &delta).unwrap();
    let record = get(&db, "conflicts", CONFLICT).unwrap();
    assert_eq!(record["status"], "evaluating");
    assert_eq!(record["resolver_candidate_id"], "candidate:scope-final");
    assert_eq!(record["resolver_delta_paths"], json!(delta));
    assert_eq!(
        crate::path_lists::load(&db, &record, "conflict_paths").unwrap(),
        ["public/tasks.mjs"]
    );
}
#[test]
fn resolver_capture_rejects_protected_paths() {
    for path in ["README.md", "fixtures/guided-task-board/oracle/run.mjs"] {
        let (db, _, capture, at) = claimed_capture();
        let error = finish(&db, &capture, &at, &["public/tasks.mjs", path]).unwrap_err();
        assert_eq!(error.code, "INVALID_CONFLICT_RESULT", "{path}");
        assert_eq!(
            get(&db, "conflicts", CONFLICT).unwrap()["status"],
            "resolving"
        );
    }
}
