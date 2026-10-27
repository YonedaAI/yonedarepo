use super::*;
use crate::native::NativeStore;

const BASE: &str = "yoneda-dev/sandbox";
const TRANSPORT: &str = super::super::sandbox::TRANSPORT;

fn call(db: &NativeStore, mut c: Value) -> Result<Value> {
    if c.get("now").is_none() {
        c["now"] = json!(1000);
    }
    crate::execute(db, c)
}

fn repository() -> NativeStore {
    let db = NativeStore::memory().unwrap();
    let policy = json!({"version":"sandbox-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"checks":[{"name":"build","argv":["node","--check","src/math.js"],"timeout_seconds":30}]}});
    call(&db, json!({"op":"init","id":"sandbox","name":"Sandbox","remote":{"namespace":"yoneda-dev","name":"sandbox"},"commit":"a".repeat(40),"policy":policy})).unwrap();
    db
}

fn task(id: &str, path: &str) -> Value {
    json!({"id":id,"title":format!("Task {id}"),"instructions":format!("Change {path}"),
        "agent":0,"depends_on":[],"write_paths":[path]})
}

/// A two-task owner plan on the sandbox runtime, with `extra` merged into the request.
fn start(extra: Value) -> Value {
    let mut c = json!({"op":"start_run","id":"run-t","intent":"Add math and its docs",
        "mode":"collaborate","agents":[{"provider":"zai","model":"glm-5.3-flash","strategy":"Builder"}],
        "team":{"version":1,"contract":"math.js exports add(a,b)","integrator_agent":0,
            "integration_paths":["src/"],"tasks":[task("math","src/math.js"),task("docs","docs/math.md")]},
        "workspace_transport":TRANSPORT,"_source_transport_approved":true,
        "_source_base":{"repository":BASE,"commit":"a".repeat(40),"tree":"b".repeat(40)}});
    for (key, value) in extra.as_object().unwrap() {
        c[key] = value.clone();
    }
    c
}

fn claim(db: &NativeStore, n: usize) -> Value {
    call(
        db,
        json!({"op":"claim","job_id":format!("job:run-t:agent-{n}")}),
    )
    .unwrap()
}

fn report(db: &NativeStore, job: &Value, landing: Value) -> Result<Value> {
    call(
        db,
        json!({"op":"sandbox_land","job_id":job["id"],"epoch":job["epoch"],"landing":landing}),
    )
}

fn landed(commit: char, team: char) -> Value {
    json!({"outcome":"landed","round":0,"commit":commit.to_string().repeat(40),
        "team_commit":team.to_string().repeat(40),"version":3})
}

fn conflict(round: u64) -> Value {
    json!({"outcome":"conflict","round":round,"paths":["docs/math.md"]})
}

#[test]
fn an_owner_plan_starts_one_sandbox_member_per_task_and_nothing_else() {
    let db = repository();
    let run = call(&db, start(json!({}))).unwrap();
    assert_eq!(run["runtime"], TRANSPORT);
    assert_eq!(run["execution_count"], 2);
    for (n, id) in [(1, "math"), (2, "docs")] {
        let e = get(&db, "executions", &format!("run-t:agent-{n}")).unwrap();
        assert_eq!(e["runtime"], TRANSPORT);
        assert_eq!(e["sandbox_task"]["id"], id);
        assert_eq!(e["strategy"], format!("Task {id}"));
        assert!(e["team_task"].is_null() && e["team_role"].is_null());
        assert_eq!(claim(&db, n)["sandbox"], true);
    }
    // No task rows, integrator, planner or coordinator: the platform merge integrates.
    assert!(
        db.query("SELECT id FROM team_tasks", &[])
            .unwrap()
            .is_empty()
    );
    assert_eq!(run_executions(&db, "run-t").unwrap().len(), 2);
}

#[test]
fn freeze_refuses_automatic_planning_delegation_peers_and_dependencies() {
    let mut dependent = start(json!({}));
    dependent["team"]["tasks"][1]["depends_on"] = json!(["math"]);
    for (case, c) in [
        ("automatic planning", start(json!({"team":null}))),
        ("dependencies", dependent),
        (
            "coordinator",
            start(json!({"autonomy_policy":{"version":1,"enabled":true}})),
        ),
    ] {
        let db = repository();
        assert_eq!(
            call(&db, c).unwrap_err().code,
            "NOT_SUPPORTED",
            "{case} must be refused"
        );
    }
    // Peers (an adaptive team) and delegation, at the freeze itself: the full start refuses
    // both earlier, for want of an approved model pool or a hosted team.
    let c = start(json!({"adaptive_team":{"version":1}}));
    let plan: TeamPlan = serde_json::from_value(c["team"].clone()).unwrap();
    let mut run = json!({"agents":c["agents"]});
    let disabled = DelegationPolicy::disabled(1);
    let refused = freeze(&c, Some(&plan), &disabled, &mut run);
    assert_eq!(refused.unwrap_err().code, "NOT_SUPPORTED");
    let delegation: DelegationPolicy =
        serde_json::from_value(json!({"enabled":true,"max_depth":1,"max_executions":2})).unwrap();
    let refused = freeze(&start(json!({})), Some(&plan), &delegation, &mut run);
    assert_eq!(refused.unwrap_err().code, "NOT_SUPPORTED");
    assert!(run["runtime"].is_null());
    freeze(&start(json!({})), Some(&plan), &disabled, &mut run).unwrap();
    assert_eq!(run["runtime"], TRANSPORT);
    assert_eq!(run["agents"][0]["cli"], "claude");
}

#[test]
fn one_conflict_resumes_once_and_the_team_branch_becomes_the_only_candidate() {
    let db = repository();
    call(&db, start(json!({}))).unwrap();
    let (first, second) = (claim(&db, 1), claim(&db, 2));
    // A member's commit is never a candidate of its own.
    let own = call(
        &db,
        json!({"op":"sandbox_finish","job_id":first["id"],"epoch":first["epoch"],"result":{}}),
    );
    assert_eq!(own.unwrap_err().code, "FORBIDDEN");
    // Round 0: the one resume, granted again for a repeated report.
    for _ in 0..2 {
        assert_eq!(report(&db, &second, conflict(0)).unwrap()["resume"], true);
    }
    report(&db, &first, landed('c', 'c')).unwrap();
    assert!(
        get(&db, "jobs", "capture:run-t:team").is_err(),
        "a member still works"
    );
    // Round 1: no second resume; the Worker fails the member with its paths.
    assert_eq!(report(&db, &second, conflict(1)).unwrap()["resume"], false);
    let member = get(&db, "executions", "run-t:agent-2").unwrap();
    assert_eq!(member["landing"]["paths"], json!(["docs/math.md"]));
    assert_eq!(member["landing"]["round"], 1);
    call(
        &db,
        json!({"op":"fail","job_id":second["id"],"epoch":second["epoch"],
        "error":"Conflicts with the team branch on docs/math.md after one resume","retryable":false}),
    )
    .unwrap();
    // Every member is done: one trusted capture of the team branch, from what landed.
    let capture = get(&db, "jobs", "capture:run-t:team").unwrap();
    assert_eq!(capture["payload"]["capture_subtype"], "sandbox_team");
    assert_eq!(
        capture["payload"]["summary"],
        "Team branch: 1 of 2 tasks landed"
    );
    let run = get(&db, "runs", "run-t").unwrap();
    assert_eq!(run["team_branch"]["landed"], 1);
    let job = call(&db, json!({"op":"claim","job_id":"capture:run-t:team"})).unwrap();
    assert!(job.get("sandbox").is_none());
    let finish = |repository: &str| {
        call(
            &db,
            json!({"op":"finish","job_id":job["id"],"epoch":job["epoch"],
            "result":{"id":"team-candidate","revision":{"repository":repository,"commit":"d".repeat(40)},
            "parents":["c".repeat(40)],"tree":"e".repeat(40),"paths":["src/math.js"],
            "summary":"Team branch: 1 of 2 tasks landed","diff_digest":"f".repeat(64)}}),
        )
    };
    assert_eq!(finish("other/repo").unwrap_err().code, "INVALID_CAPTURE");
    finish(BASE).unwrap();
    let candidate = get(&db, "candidates", "team-candidate").unwrap();
    assert_eq!(candidate["execution"], "run-t:team");
    assert_eq!(candidate["revision"]["commit"], "d".repeat(40));
    let run = get(&db, "runs", "run-t").unwrap();
    super::super::team::validate_candidate(&db, &run, &candidate).unwrap();
    // The team branch is checked in a fresh check sandbox like any sandbox candidate.
    let check = call(
        &db,
        json!({"op":"claim","job_id":"evaluate:team-candidate"}),
    )
    .unwrap();
    assert_eq!(check["sandbox_check"], true);
}

#[test]
fn a_team_where_nothing_landed_fails_without_a_candidate() {
    let db = repository();
    call(&db, start(json!({}))).unwrap();
    for n in [1, 2] {
        let job = claim(&db, n);
        call(
            &db,
            json!({"op":"fail","job_id":job["id"],"epoch":job["epoch"],
            "error":"Claude Code failed: API Error: 401","retryable":false}),
        )
        .unwrap();
    }
    let run = get(&db, "runs", "run-t").unwrap();
    assert_eq!(run["status"], "failed");
    assert!(get(&db, "jobs", "capture:run-t:team").is_err());
}

#[test]
fn landings_are_validated() {
    let db = repository();
    call(&db, start(json!({}))).unwrap();
    let job = claim(&db, 1);
    for landing in [
        json!({"outcome":"conflict","round":0,"paths":[]}),
        json!({"outcome":"conflict","round":0,"paths":["../etc/passwd"]}),
        json!({"outcome":"conflict","round":2,"paths":["a"]}),
        json!({"outcome":"landed","round":0,"commit":"x","team_commit":"c".repeat(40)}),
        json!({"outcome":"merged","round":0}),
    ] {
        assert!(report(&db, &job, landing).is_err());
    }
    let mut stale = job.clone();
    stale["epoch"] = json!(0);
    assert_eq!(
        report(&db, &stale, landed('c', 'c')).unwrap_err().code,
        "FENCED"
    );
}

#[test]
fn team_members_run_the_cli_of_their_frozen_agent() {
    let db = repository();
    let mut request = start(json!({}));
    request["agents"][0]["cli"] = json!("opencode");
    call(&db, request).unwrap();
    for n in 1..=2 {
        let execution = get(&db, "executions", &format!("run-t:agent-{n}")).unwrap();
        assert_eq!(execution["cli"], "opencode");
    }
    let mut refused = start(json!({"id":"run-u"}));
    refused["agents"][0]["cli"] = json!("codex");
    assert_eq!(call(&db, refused).unwrap_err().code, "SANDBOX_HARNESS");
}
