//! Native SQLite command regressions; no inference, network or funding.
use crate::{execute, native::NativeStore, storage::*};
use serde_json::{Value, json};
#[path = "guided_test_fixture.rs"]
mod evidence_fixture;
fn fixture() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    execute(&db,json!({"op":"init","now":1,"id":"guide-repo","name":"Task board","workspace":"owner","remote":{"namespace":"owner","name":"tasks"},"commit":"a".repeat(40),"policy":{"version":"task-board-v1","suite":"commands-v1","environment":"linux-node24-rust1.94-v1","required_checks":["board"],"build":{"setup":[],"checks":[{"name":"board","argv":["node","--check","public/tasks.mjs"],"timeout_seconds":30}]}}})).unwrap();
    db
}
fn prepared() -> Value {
    json!({"id":"caller-id-ignored","intent":"Implement task board","mode":"collaborate","agents":[{"provider":"zai","model":"glm-5.3-flash","strategy":"core"},{"provider":"zai","model":"glm-5.3-flash","strategy":"ui"}],"team":{"version":1,"contract":"Stable task IDs","integrator_agent":1,"integration_paths":["public/tasks.mjs","public/app.mjs"],"tasks":[{"id":"core","title":"Core","instructions":"Implement functions","agent":0,"depends_on":[],"write_paths":["public/tasks.mjs"]},{"id":"ui","title":"Interface","instructions":"Implement interface","agent":1,"depends_on":[],"write_paths":["public/app.mjs"]}]}})
}
fn request(step: &str) -> Value {
    json!({"op":"start_guided_step","_workspace":"owner","session_id":"guide-session:demo","profile_id":"task-board-v1","step_id":step,"request_id":format!("start-{step}"),"expected_commit":"a".repeat(40),"expected_version":0,"_guided_runs":[prepared()],"now":2})
}
fn read(db: &NativeStore) -> Value {
    execute(
        db,
        json!({"op":"guided_session","_workspace":"owner","id":"guide-session:demo"}),
    )
    .unwrap()
}
#[test]
fn guided_first_step_atomically_creates_platform_session_branch_run_and_dispatch() {
    let db = fixture();
    let response = execute(&db, request("build")).unwrap();
    assert_eq!(response["steps"][0]["status"], "running");
    assert_eq!(response["steps"][1]["status"], "locked");
    let runs = all(&db, "runs").unwrap();
    assert_eq!(runs.len(), 1);
    assert_ne!(runs[0]["id"], "caller-id-ignored");
    assert_eq!(
        runs[0]["guided"],
        json!({"session_id":"guide-session:demo","profile_id":"task-board-v1","version":1,"step_id":"build","check_phase":"build"})
    );
    let session = get(&db, "nodes", "guide-session:demo").unwrap();
    assert_eq!(session["author"], "platform");
    assert_eq!(session["kind"], "guided_session");
    assert_eq!(all(&db, "working_branches").unwrap().len(), 1);
    assert!(
        !execute(&db, json!({"op":"outbox"})).unwrap()["jobs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[test]
fn guided_replay_and_read_never_allocate_second_run_or_jobs() {
    let db = fixture();
    let first = execute(&db, request("build")).unwrap();
    let jobs = all(&db, "jobs").unwrap();
    let events = db.query("SELECT * FROM events", &[]).unwrap();
    assert_eq!(execute(&db, request("build")).unwrap(), first);
    let mut refresh = request("build");
    refresh["request_id"] = json!("reload-new-request");
    assert_eq!(
        execute(&db, refresh).unwrap()["steps"][0]["run_ids"],
        first["steps"][0]["run_ids"]
    );
    read(&db);
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    assert_eq!(db.query("SELECT * FROM events", &[]).unwrap(), events);
}
#[test]
fn guided_owner_scope_phase_and_trusted_preparation_fail_without_partial_state() {
    for (key, value, code) in [
        ("job_id", json!("agent"), "FORBIDDEN"),
        ("_workspace", json!("other"), "FORBIDDEN"),
        ("step_id", json!("extend"), "GUIDED_STEP_LOCKED"),
        ("expected_commit", json!("b".repeat(40)), "HEAD_MOVED"),
        ("_guided_runs", json!([]), "INVALID_INPUT"),
    ] {
        let db = fixture();
        let before = execute(&db, json!({"op":"snapshot"})).unwrap();
        let mut c = request("build");
        c[key] = value;
        assert_eq!(execute(&db, c).unwrap_err().code, code);
        assert_eq!(execute(&db, json!({"op":"snapshot"})).unwrap(), before);
    }
}
#[test]
fn guided_reserved_session_node_cannot_be_overwritten_by_agent_artifact() {
    let db = fixture();
    let mut c = prepared();
    c["op"] = json!("start_run");
    c["id"] = json!("ordinary");
    execute(&db, c).unwrap();
    let job = all(&db, "jobs")
        .unwrap()
        .into_iter()
        .find(|j| j["kind"] == "agent")
        .unwrap();
    let claimed = execute(&db, json!({"op":"claim","job_id":job["id"],"now":3})).unwrap();
    node(
        &db,
        "guide-session:protected",
        "guided_session",
        "Guide",
        "platform",
        1,
        json!({"protected":true}),
    )
    .unwrap();
    let before = get(&db, "nodes", "guide-session:protected").unwrap();
    let result = execute(
        &db,
        json!({"op":"publish_artifact","job_id":claimed["id"],"epoch":claimed["epoch"],"now":4,"id":"guide-session:protected","digest":"f".repeat(64),"label":"Claim completed","kind":"guide","metadata":{}}),
    );
    assert_eq!(result.unwrap_err().code, "FORBIDDEN");
    assert_eq!(
        get(&db, "nodes", "guide-session:protected").unwrap(),
        before
    );
}
#[test]
fn guided_checked_contributions_without_actual_harness_overlap_do_not_complete_build() {
    let db = fixture();
    let response = execute(&db, request("build")).unwrap();
    let rid = response["steps"][0]["run_ids"][0].as_str().unwrap();
    evidence_fixture::checked(&db, rid, "build", false);
    assert_ne!(read(&db)["steps"][0]["status"], "complete");
    assert!(
        read(&db)["steps"][0]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "collaboration" && e["verified"] == false)
    );
}
#[test]
fn guided_actual_parallel_captured_sources_and_linked_design_choice_unlock_extend_pure_read() {
    let db = fixture();
    let response = execute(&db, request("build")).unwrap();
    let rid = response["steps"][0]["run_ids"][0].as_str().unwrap();
    evidence_fixture::checked(&db, rid, "build", true);
    let jobs = all(&db, "jobs").unwrap();
    let events = db.query("SELECT * FROM events", &[]).unwrap();
    let session = read(&db);
    assert_eq!(session["steps"][0]["status"], "complete");
    assert_eq!(session["steps"][1]["status"], "ready");
    let handoffs = all(&db, "team_handoffs")
        .unwrap()
        .into_iter()
        .filter(|handoff| handoff["run_id"] == rid && handoff["authority"] == "captured_revision")
        .collect::<Vec<_>>();
    assert_eq!(handoffs.len(), 2);
    for handoff in handoffs {
        assert_eq!(
            get(
                &db,
                "jobs",
                handoff["output"]["capture_job"].as_str().unwrap()
            )
            .unwrap()["status"],
            "done"
        );
    }
    assert_eq!(
        get(&db, "nodes", &format!("context:choice:{rid}")).unwrap()["kind"],
        "proposed_decision"
    );
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
    assert_eq!(db.query("SELECT * FROM events", &[]).unwrap(), events);
    assert!(all(&db, "decisions").unwrap().is_empty());
    assert_eq!(session["working_revision"]["commit"], "b".repeat(40));
    assert_eq!(session["working_version"], 1);
}
#[test]
fn guided_only_exact_replay_ignores_moved_head_new_request_fences() {
    let db = fixture();
    let first = execute(&db, request("build")).unwrap();
    let rid = first["steps"][0]["run_ids"][0].as_str().unwrap();
    evidence_fixture::checked(&db, rid, "build", true);
    assert_eq!(
        execute(&db, request("build")).unwrap()["steps"][0]["run_ids"],
        first["steps"][0]["run_ids"]
    );
    let mut moved = request("build");
    moved["request_id"] = json!("different-request");
    assert_eq!(execute(&db, moved).unwrap_err().code, "HEAD_MOVED");
}
#[test]
fn guided_partial_checked_candidate_cannot_allocate_owner_publication() {
    let db = fixture();
    let response = execute(&db, request("build")).unwrap();
    let rid = response["steps"][0]["run_ids"][0].as_str().unwrap();
    let candidate = evidence_fixture::checked(&db, rid, "build", true);
    let before = execute(&db, json!({"op":"snapshot"})).unwrap();
    let result = execute(
        &db,
        json!({"op":"accept","request_id":"partial-publication","candidate":candidate,"expected_commit":"a".repeat(40),"expected_version":0,"rationale":"Owner review of partial stage","now":60}),
    );
    assert_eq!(result.unwrap_err().code, "GUIDED_NOT_PUBLISHABLE");
    assert_eq!(execute(&db, json!({"op":"snapshot"})).unwrap(), before);
}
fn through_extend() -> (NativeStore, Value) {
    let db = fixture();
    let started = execute(&db, request("build")).unwrap();
    let first = started["steps"][0]["run_ids"][0].as_str().unwrap();
    evidence_fixture::checked(&db, first, "build", true);
    let prior = format!("context:choice:{first}");
    let mut c = request("extend");
    c["expected_commit"] = json!("b".repeat(40));
    c["expected_version"] = json!(1);
    let extended = execute(&db, c).unwrap();
    let rid = extended["steps"][1]["run_ids"][0].as_str().unwrap();
    assert!(
        get(&db, "runs", rid).unwrap()["context"]
            .as_array()
            .unwrap()
            .contains(&json!(prior))
    );
    evidence_fixture::checked_with_context(&db, rid, "extend", true, Some(&prior));
    let view = read(&db);
    assert_eq!(view["steps"][1]["status"], "complete");
    (db, view)
}
#[test]
fn guided_extension_requires_actual_prior_read_receipt_and_source_author_citation() {
    let (db, view) = through_extend();
    assert_eq!(view["steps"][2]["status"], "ready");
    db.query("DELETE FROM context_access", &[]).unwrap();
    assert_ne!(read(&db)["steps"][1]["status"], "complete");
}
#[test]
fn guided_concurrent_starts_exact_two_frozen_variants_and_rolls_back_second_failure() {
    let (db, view) = through_extend();
    let mut c = request("concurrent");
    c["expected_commit"] = view["working_revision"]["commit"].clone();
    c["expected_version"] = view["working_version"].clone();
    let mut bad = prepared();
    bad["intent"] = Value::Null;
    c["_guided_runs"] = json!([prepared(), bad]);
    let before = execute(&db, json!({"op":"snapshot"})).unwrap();
    assert!(execute(&db, c.clone()).is_err());
    assert_eq!(execute(&db, json!({"op":"snapshot"})).unwrap(), before);
    c["_guided_runs"] = json!([prepared(), prepared()]);
    let started = execute(&db, c.clone()).unwrap();
    let ids = started["steps"][2]["run_ids"].as_array().unwrap();
    assert_eq!(ids.len(), 2);
    let left = get(&db, "runs", ids[0].as_str().unwrap()).unwrap();
    let right = get(&db, "runs", ids[1].as_str().unwrap()).unwrap();
    assert_eq!(left["base"], right["base"]);
    assert_eq!(left["guided"]["check_phase"], "parallel");
    assert_eq!(left["guided"]["variant"], "filter");
    assert_eq!(right["guided"]["variant"], "sort");
    let jobs = all(&db, "jobs").unwrap();
    assert_eq!(execute(&db, c).unwrap()["steps"][2]["run_ids"], json!(ids));
    assert_eq!(all(&db, "jobs").unwrap(), jobs);
}

#[path = "guided_stale_tests.rs"]
mod stale;

#[test]
fn guided_initial_lease_uses_current_canonical_version_before_branch_exists() {
    let db = fixture();
    let mut repository = repo(&db).unwrap();
    // An existing canonical publication can have a nonzero lease version.
    repository["version"] = json!(3);
    save(&db, "repository", "repo", &repository).unwrap();
    let mut start = request("build");
    start["expected_version"] = json!(3);
    let started = execute(&db, start).unwrap();
    assert_eq!(started["working_version"], 0);
    let run = get(
        &db,
        "runs",
        started["steps"][0]["run_ids"][0].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(run["working_branch_version"], 0);
    assert_eq!(run["base"]["commit"], repository["published_commit"]);
}
#[test]
fn guided_continuation_read_from_foreign_epoch_cannot_qualify_captured_contribution() {
    let (db, _) = through_extend();
    db.query("UPDATE context_access SET epoch=epoch+1", &[])
        .unwrap();
    assert_ne!(read(&db)["steps"][1]["status"], "complete");
}
/// Hosted repo-7fb16a12 shape: extend specialists cite the build integrator's decision, which
/// explicitly supersedes the specialist choice that the build evidence selected.
fn extend_citing_integrator_decision(tamper: impl FnOnce(&NativeStore, &str)) -> Value {
    let db = fixture();
    let started = execute(&db, request("build")).unwrap();
    let first = started["steps"][0]["run_ids"][0].as_str().unwrap();
    evidence_fixture::checked_with_integrator_decision(&db, first);
    let session = read(&db);
    assert_eq!(session["steps"][0]["status"], "complete");
    assert!(
        session["steps"][0]["evidence"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["record_id"] == format!("context:choice:{first}"))
    );
    let integrated = format!("context:integrated:{first}");
    tamper(&db, &integrated);
    let mut c = request("extend");
    c["expected_commit"] = json!("b".repeat(40));
    c["expected_version"] = json!(1);
    let extended = execute(&db, c).unwrap();
    let rid = extended["steps"][1]["run_ids"][0].as_str().unwrap();
    evidence_fixture::checked_with_context(&db, rid, "extend", true, Some(&integrated));
    read(&db)
}
#[test]
fn guided_extension_citing_captured_integrator_supersession_of_choice_completes() {
    let view = extend_citing_integrator_decision(|_, _| {});
    assert_eq!(view["steps"][1]["status"], "complete");
}
#[test]
fn guided_extension_citing_supersession_by_uncaptured_author_does_not_complete() {
    let view = extend_citing_integrator_decision(|db, id| {
        db.query(
            "UPDATE nodes SET payload=json_set(payload,'$.author','foreign-execution') WHERE id=?",
            &[json!(id)],
        )
        .unwrap();
        assert_eq!(get(db, "nodes", id).unwrap()["author"], "foreign-execution");
    });
    assert_ne!(view["steps"][1]["status"], "complete");
}
#[test]
fn guided_extension_citing_integrator_record_without_supersedes_link_does_not_complete() {
    let view = extend_citing_integrator_decision(|db, id| {
        db.query(
            "UPDATE nodes SET payload=json_set(payload,'$.data.links',json('[]')) WHERE id=?",
            &[json!(id)],
        )
        .unwrap();
        assert_eq!(get(db, "nodes", id).unwrap()["data"]["links"], json!([]));
    });
    assert_ne!(view["steps"][1]["status"], "complete");
}
