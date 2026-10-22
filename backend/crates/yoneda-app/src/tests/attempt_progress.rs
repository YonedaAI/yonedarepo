//! Progress, not wall clock, decides when an agent attempt stops; timeouts retry and resume.
use super::*;

const MINUTE: i64 = 60_000;

fn team(budgets: Option<Value>) -> NativeStore {
    let db = repo_with_policy(json!({"version":"team-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/app.js"],"timeout_seconds":30}]}}));
    let mut request = json!({"op":"start_run","id":"laundry","now":0,
        "intent":"Build a laundry pickup order site","mode":"collaborate","agents":[
        {"provider":"zai","model":"glm-5.3-flash","strategy":"specialist"},
        {"provider":"zai","model":"glm-5.3-flash","strategy":"integrator"}],
        "team":{"version":1,"contract":"public/order.js exports total; tests cover it.",
        "integrator_agent":1,"integration_paths":["public/app.js"],"tasks":[
        {"id":"site","title":"Order site","instructions":"Build the order site","agent":0,"depends_on":[],"write_paths":["public/order.js"]},
        {"id":"tests","title":"Order tests","instructions":"Add Node tests","agent":0,"depends_on":["site"],"write_paths":["tests/order.test.js"]}]}});
    if let Some(budgets) = budgets {
        request["model_budgets"] = budgets;
    }
    call(&db, request).unwrap();
    db
}
fn at(db: &NativeStore, mut c: Value, now: i64) -> Result<Value> {
    c["now"] = json!(now);
    execute(db, c)
}
fn task(db: &NativeStore, local: &str) -> Value {
    crate::storage::get(db, "team_tasks", &format!("laundry:task:{local}")).unwrap()
}
const JOB: &str = "job:laundry:task:site";
fn started(db: &NativeStore, now: i64) -> Value {
    let job = at(db, json!({"op":"claim","job_id":JOB}), now).unwrap();
    at(
        db,
        json!({"op":"progress","job_id":JOB,"epoch":job["epoch"],
        "progress":{"stage":"container_ready"}}),
        now + 1000,
    )
    .unwrap();
    job
}
fn beat(db: &NativeStore, epoch: &Value, active: bool, now: i64) -> Result<Value> {
    at(
        db,
        json!({"op":"heartbeat","job_id":JOB,"epoch":epoch,"active":active}),
        now,
    )
}

#[test]
fn a_supervisor_from_before_the_watchdog_is_never_fenced_early_during_rollout() {
    let db = team(None);
    let job = started(&db, 1000);
    // No `active` field: the old image still stops itself at its own fixed wall clock.
    for now in (22_000..12 * MINUTE).step_by(20_000) {
        at(
            &db,
            json!({"op":"heartbeat","job_id":JOB,"epoch":job["epoch"]}),
            now,
        )
        .unwrap();
    }
}

#[test]
fn a_progressing_attempt_is_never_fenced_before_the_hard_ceiling() {
    let db = team(None);
    let job = started(&db, 1000);
    let ready = 2000;
    // Laundry attempt 1 was killed at 592 s while still making a model request every ~25 s.
    let mut now = ready;
    while now < ready + 30 * MINUTE - 20_000 {
        now += 20_000;
        let lease = beat(&db, &job["epoch"], true, now).unwrap();
        assert!(lease["attempt_deadline"].as_i64().unwrap() > now);
        assert!(lease["attempt_deadline"].as_i64().unwrap() <= ready + 30 * MINUTE);
        at(
            &db,
            json!({"op":"check_attempt","job_id":JOB,"epoch":job["epoch"]}),
            now,
        )
        .unwrap();
    }
    assert!(
        now > ready + 10 * MINUTE,
        "survived the old 10 minute wall clock"
    );
    let fenced = at(
        &db,
        json!({"op":"check_attempt","job_id":JOB,"epoch":job["epoch"]}),
        ready + 30 * MINUTE,
    );
    assert_eq!(fenced.unwrap_err().code, "FENCED");
}

#[test]
fn an_idle_attempt_is_fenced_after_the_no_progress_window() {
    let db = team(None);
    let job = started(&db, 1000);
    let ready = 2000;
    // Trusted heartbeats without progress keep the lease but never move the deadline.
    let mut now = ready;
    let mut last = Ok(json!({}));
    while now < ready + 6 * MINUTE + 1000 {
        now += 20_000;
        last = beat(&db, &job["epoch"], false, now);
        if last.is_err() {
            break;
        }
        assert_eq!(
            last.as_ref().unwrap()["attempt_deadline"],
            ready + 5 * MINUTE + 60_000
        );
    }
    assert_eq!(last.unwrap_err().code, "FENCED");
    assert!(now <= ready + 6 * MINUTE + 20_000);
}

#[test]
fn a_provider_wait_counts_as_progress_up_to_the_per_request_cap() {
    let db = team(None);
    let job = started(&db, 1000);
    at(
        &db,
        json!({"op":"reserve_request","job_id":JOB,"epoch":job["epoch"],"kind":"model",
        "input_bytes":100,"output_tokens":4096}),
        10_000,
    )
    .unwrap();
    // A slow provider response with no harness output: still progress while in flight.
    let mut now = 10_000;
    while now < 10_000 + 10 * MINUTE - 20_000 {
        now += 20_000;
        let lease = beat(&db, &job["epoch"], false, now).unwrap();
        assert_eq!(lease["model_active"], true);
    }
    // Past the per-request cap a hung request no longer extends the attempt.
    now += 20_000;
    let lease = beat(&db, &job["epoch"], false, now).unwrap();
    assert_eq!(lease["model_active"], false);
    let deadline = lease["attempt_deadline"].as_i64().unwrap();
    assert!(deadline <= now + 5 * MINUTE + 60_000);
    while now + 20_000 < deadline {
        now += 20_000;
        assert_eq!(
            beat(&db, &job["epoch"], false, now).unwrap()["attempt_deadline"],
            deadline
        );
    }
    assert_eq!(
        beat(&db, &job["epoch"], false, deadline).unwrap_err().code,
        "FENCED"
    );
}

fn bind_source(db: &NativeStore, workspace: &str, epoch: i64) {
    db.query("UPDATE jobs SET payload=json_set(payload,'$.payload.workspace_transport','api-source-v1','$.source_bindings',json(?)) WHERE id=?",
        &[json!(json!({"view":{"binding":{"workspace_id":workspace,"view_digest":"d".repeat(64),
            "access":"read_write","write_paths":["public/order.js"]},"producer_epoch":epoch}}).to_string()), json!(JOB)]).unwrap();
}

#[test]
fn a_timed_out_task_retries_from_its_staged_checkpoint() {
    let db = team(None);
    let job = started(&db, 1000);
    bind_source(
        &db,
        "source-workspace:first",
        job["epoch"].as_i64().unwrap(),
    );
    at(
        &db,
        json!({"op":"fail","job_id":JOB,"epoch":job["epoch"],"retryable":false,
        "error":"EXECUTION_TIMEOUT: No agent progress for 5 minutes"}),
        50_000,
    )
    .unwrap();
    let failed = task(&db, "site");
    assert_eq!(failed["status"], "failed");
    assert_eq!(task(&db, "tests")["status"], "blocked");
    let retried = at(
        &db,
        json!({"op":"retry_team_task","run_id":"laundry","task_id":"site",
        "expected_epoch":failed["epoch"],"expected_revision":failed["revision"]}),
        500_000,
    )
    .unwrap();
    assert_eq!(retried["status"], "queued");
    let next = at(&db, json!({"op":"claim","job_id":JOB}), 510_000).unwrap();
    assert_eq!(next["resume"]["workspace_id"], "source-workspace:first");
    assert_eq!(next["resume"]["reason"], "EXECUTION_TIMEOUT");
    assert_eq!(next["resume"]["epoch"], job["epoch"]);
    // A retry that times out again before binding keeps the original checkpoint.
    at(
        &db,
        json!({"op":"fail","job_id":JOB,"epoch":next["epoch"],"retryable":true,
        "error":"EXECUTION_TIMEOUT: Attempt reached the 30 minute ceiling"}),
        520_000,
    )
    .unwrap();
    let again = at(&db, json!({"op":"claim","job_id":JOB}), 530_000).unwrap();
    assert_eq!(again["resume"]["workspace_id"], "source-workspace:first");
    // The resumed attempt's own workspace becomes the newest checkpoint.
    bind_source(
        &db,
        "source-workspace:second",
        again["epoch"].as_i64().unwrap(),
    );
    at(
        &db,
        json!({"op":"fail","job_id":JOB,"epoch":again["epoch"],"retryable":false,
        "error":"HARNESS_INTERRUPTED: runtime stopped"}),
        540_000,
    )
    .unwrap();
    assert_eq!(
        crate::storage::get(&db, "jobs", JOB).unwrap()["resume_from"]["workspace_id"],
        "source-workspace:second"
    );
}

#[test]
fn a_task_that_timed_out_before_this_change_still_resumes_on_retry() {
    // The laundry task failed under the old wall clock: no checkpoint was recorded, but the
    // failed job still holds its epoch's source binding until the next claim.
    let db = team(None);
    let job = started(&db, 1000);
    bind_source(
        &db,
        "source-workspace:laundry",
        job["epoch"].as_i64().unwrap(),
    );
    at(
        &db,
        json!({"op":"fail","job_id":JOB,"epoch":job["epoch"],"retryable":false,
        "error":"EXECUTION_TIMEOUT: Execution deadline exceeded"}),
        50_000,
    )
    .unwrap();
    db.query(
        "UPDATE jobs SET payload=json_remove(payload,'$.resume_from') WHERE id=?",
        &[json!(JOB)],
    )
    .unwrap();
    let failed = task(&db, "site");
    at(
        &db,
        json!({"op":"retry_team_task","run_id":"laundry","task_id":"site",
        "expected_epoch":failed["epoch"],"expected_revision":failed["revision"]}),
        60_000,
    )
    .unwrap();
    let next = at(&db, json!({"op":"claim","job_id":JOB}), 70_000).unwrap();
    assert_eq!(next["resume"]["workspace_id"], "source-workspace:laundry");
}

#[test]
fn a_failure_on_its_merits_is_never_replayed_into_the_retry() {
    let db = team(None);
    let job = started(&db, 1000);
    bind_source(&db, "source-workspace:bad", job["epoch"].as_i64().unwrap());
    at(
        &db,
        json!({"op":"fail","job_id":JOB,"epoch":job["epoch"],"retryable":false,
        "error":"WRITE_SCOPE: Agent wrote outside its paths"}),
        60_000,
    )
    .unwrap();
    let failed = task(&db, "site");
    at(
        &db,
        json!({"op":"retry_team_task","run_id":"laundry","task_id":"site",
        "expected_epoch":failed["epoch"],"expected_revision":failed["revision"]}),
        70_000,
    )
    .unwrap();
    let next = at(&db, json!({"op":"claim","job_id":JOB}), 80_000).unwrap();
    assert!(next["resume"].is_null());
}

#[test]
fn a_successful_retry_after_timeout_unblocks_dependent_tasks() {
    let db = team(None);
    let job = started(&db, 1000);
    at(
        &db,
        json!({"op":"fail","job_id":JOB,"epoch":job["epoch"],"retryable":false,
        "error":"EXECUTION_TIMEOUT: No agent progress for 5 minutes"}),
        50_000,
    )
    .unwrap();
    let failed = task(&db, "site");
    at(
        &db,
        json!({"op":"retry_team_task","run_id":"laundry","task_id":"site",
        "expected_epoch":failed["epoch"],"expected_revision":failed["revision"]}),
        500_000,
    )
    .unwrap();
    let next = at(&db, json!({"op":"claim","job_id":JOB}), 510_000).unwrap();
    at(
        &db,
        json!({"op":"finish","job_id":JOB,"epoch":next["epoch"],
        "result":{"workspace":"b".repeat(64)}}),
        520_000,
    )
    .unwrap();
    let capture = at(
        &db,
        json!({"op":"claim","job_id":"capture:laundry:task:site:r2"}),
        530_000,
    )
    .unwrap();
    at(
        &db,
        json!({"op":"finish","job_id":capture["id"],"epoch":capture["epoch"],"result":{
        "id":"captured-site","revision":{"repository":"test/site","commit":"e".repeat(40)},
        "tree":"c".repeat(40),"paths":["public/order.js"],"summary":"site","diff":"d"}}),
        540_000,
    )
    .unwrap();
    assert_eq!(task(&db, "site")["status"], "complete");
    assert_eq!(task(&db, "tests")["status"], "queued");
}

#[test]
fn spend_fit_grants_a_smaller_response_instead_of_refusing_and_never_passes_the_limit() {
    // 1 µ$ per input token, 4 µ$ per output token, 20 000 µ$ limit.
    let budget = json!([{"provider":"zai","model":"glm-5.3-flash","max_requests":null,
        "max_output_tokens":4096,"max_execution_ms":600000,"spend_limit_microusd":20000,
        "pricing":{"input_microusd_per_million":1000000,"output_microusd_per_million":4000000,
        "source":"owner-approved conservative rates"}}]);
    let db = team(Some(budget));
    let job = started(&db, 1000);
    let reserve = |now: i64| {
        at(
            &db,
            json!({"op":"reserve_request","job_id":JOB,"epoch":job["epoch"],"kind":"model",
            "input_bytes":1000,"output_tokens":4096}),
            now,
        )
    };
    // First request: worst case 9192 + 16384 = 25 576 µ$ exceeds the whole limit. The old rule
    // refused it outright; actual use (settled below) is a small fraction of that.
    let first = reserve(10_000).unwrap();
    assert_eq!(first["output_tokens"], 2702);
    assert!(first["reservation_microusd"].as_i64().unwrap() <= 20_000);
    at(
        &db,
        json!({"op":"settle_model_request","job_id":JOB,"epoch":job["epoch"],
        "reservation_id":first["reservation_id"],"input_tokens":400,"output_tokens":300}),
        11_000,
    )
    .unwrap();
    let second = reserve(12_000).unwrap();
    assert!(second["output_tokens"].as_i64().unwrap() >= 256);
    let run = crate::storage::get(&db, "runs", "laundry").unwrap();
    assert!(
        run["model_budgets"][0]["charged_microusd"]
            .as_i64()
            .unwrap()
            <= 20_000
    );
    // Once even a 256-token reply cannot fit, the request is refused with real numbers.
    let refused = reserve(13_000).unwrap_err();
    assert_eq!(refused.code, "MODEL_SPEND_LIMIT");
    assert!(
        refused.message.contains("of 20000 remain"),
        "{}",
        refused.message
    );
}

#[test]
fn timeouts_do_not_consume_the_three_attempt_retry_cap_but_real_failures_do() {
    let db = team(None);
    let mut now = 1000;
    for round in 0..4 {
        let job = started(&db, now);
        let error = if round < 3 {
            "EXECUTION_TIMEOUT: No agent progress for 5 minutes"
        } else {
            "WRITE_SCOPE: Agent wrote outside its paths"
        };
        at(
            &db,
            json!({"op":"fail","job_id":JOB,"epoch":job["epoch"],"retryable":false,
            "error":error}),
            now + 30_000,
        )
        .unwrap();
        let failed = task(&db, "site");
        assert_eq!(failed["error"], error);
        let retry = at(
            &db,
            json!({"op":"retry_team_task","run_id":"laundry","task_id":"site",
            "expected_epoch":failed["epoch"],"expected_revision":failed["revision"]}),
            now + 40_000,
        );
        if round < 3 {
            assert_eq!(retry.unwrap()["revision"], round + 2);
        } else {
            assert_eq!(retry.unwrap_err().code, "ATTEMPTS_EXHAUSTED");
        }
        now += 60_000;
    }
}
