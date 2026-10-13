use super::autonomous_tests::fixture;
use super::*;
use crate::{execute, native::NativeStore};

fn protected() -> NativeStore {
    let db = fixture();
    let mut repository = repo(&db).unwrap();
    repository["policy"]["build"]["test_bundle"] =
        json!({"digest":"a".repeat(64),"protected_paths":["schema.json","checks/"]});
    save(&db, "repository", "repo", &repository).unwrap();
    db
}

fn start() -> Value {
    json!({"op":"start_run","id":"scoped","intent":"Implement public source only","mode":"collaborate","agents":[{"provider":"mimo","model":"mimo-v2.6-flash","strategy":"source"}],"now":10})
}

fn plan(path: &str, integration: bool) -> Value {
    json!({"version":1,"contract":"Public source contract","integrator_agent":0,"integration_paths":if integration{json!([path])}else{json!(["public/"])},"tasks":[{"id":"feature","title":"Feature","instructions":"Implement public source","agent":0,"depends_on":[],"write_paths":if integration{json!(["public/feature.js"])}else{json!([path])}}]})
}

#[test]
fn initial_planner_rejects_protected_and_git_scopes_before_activating_any_draft() {
    for path in [
        "schema.json",
        "schema.json/child",
        "checks",
        "checks/runner.js",
        ".git/config",
        "src/.git/config",
    ] {
        for integration in [false, true] {
            let db = protected();
            execute(&db, start()).unwrap();
            execute(
                &db,
                json!({"op":"claim","job_id":"job:scoped:planner","now":11}),
            )
            .unwrap();
            let before = get(&db, "runs", "scoped").unwrap();
            let result = execute(
                &db,
                json!({"op":"team_plan_propose","job_id":"job:scoped:planner","epoch":1,"plan":plan(path,integration),"now":12}),
            );
            assert_eq!(
                result.unwrap_err().code,
                if path.split('/').any(|part| part == ".git") {
                    "UNSAFE_PATH"
                } else {
                    "FORBIDDEN"
                },
                "scope {path}"
            );
            assert_eq!(get(&db, "runs", "scoped").unwrap(), before);
            assert!(rows(&db, "team_tasks", "scoped").unwrap().is_empty());
        }
    }
}

#[test]
fn manual_initial_plan_is_protected_even_without_autonomy_opt_in() {
    let db = protected();
    let before = all(&db, "runs").unwrap();
    let mut command = start();
    command["team"] = plan("schema.json", false);
    assert_eq!(execute(&db, command).unwrap_err().code, "FORBIDDEN");
    assert_eq!(all(&db, "runs").unwrap(), before);
    assert!(rows(&db, "team_tasks", "scoped").unwrap().is_empty());
}

#[test]
fn planner_scope_validation_uses_the_original_approved_policy_after_policy_moves() {
    let db = protected();
    execute(&db, start()).unwrap();
    execute(
        &db,
        json!({"op":"claim","job_id":"job:scoped:planner","now":11}),
    )
    .unwrap();
    let mut run = get(&db, "runs", "scoped").unwrap();
    run["policy"]["build"]["test_bundle"]["protected_paths"] = json!([]);
    save(&db, "runs", "scoped", &run).unwrap();
    assert_eq!(execute(&db,json!({"op":"team_plan_propose","job_id":"job:scoped:planner","epoch":1,"plan":plan("schema.json",false),"now":12})).unwrap_err().code,"FORBIDDEN");
}
