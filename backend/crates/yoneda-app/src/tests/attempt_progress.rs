//! Progress, not wall clock, decides when an agent attempt stops; timeouts retry and resume.
use super::*;

const MINUTE: i64 = 60_000;

fn team(budgets: Option<Value>) -> NativeStore {
    let db = repo_with_policy(json!({"version":"team-v1","suite":"commands-v1",
        "environment":"linux-node24-rust1.94-v1","required_checks":["build"],
        "build":{"setup":[],"checks":[{"name":"build","argv":["node","--check","public/app.js"],"timeout_seconds":30}]}}));
    let mut request = json!({"op":"start_run","id":"laundry","now":0,
        "intent":"Build a laundry pickup order site",
        "agents":[{"provider":"zai","model":"glm-5.3-flash","strategy":"builder"}]});
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
const JOB: &str = "job:laundry:agent-1";
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
