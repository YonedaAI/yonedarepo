//! Attempt time is governed by progress, not wall clock.
//!
//! A budgeted agent attempt keeps two deadlines: a hard `attempt_ceiling_at` safety net and a
//! rolling `attempt_deadline` that moves forward whenever progress is observed. Progress is a
//! supervisor heartbeat reporting harness output, tool calls or file writes, or ledger-observed
//! model activity (a reserved request, a settled response, or a request still in flight within
//! its per-request cap). The supervisor's idle watchdog stops first; the ledger deadline trails it
//! by [`PROGRESS_GRACE_MS`] so a progressing attempt is never fenced by the ledger.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Result, model_budget::ModelBudget};

/// Covers the 20 s heartbeat interval plus the supervisor's 10 s failure-report window.
pub(in crate::commands) const PROGRESS_GRACE_MS: i64 = 60_000;
/// One provider request counts as progress while in flight for at most this long.
pub(in crate::commands) const MODEL_REQUEST_PROGRESS_CAP_MS: i64 = 600_000;
/// Boot and source preparation window before the runtime reports readiness.
const BOOT_MS: i64 = 120_000;
const LEGACY_AGENT_MS: i64 = 600_000;

/// Wall-clock ceiling for one attempt of this job.
pub(in crate::commands) fn ceiling_ms(job: &Value, budget: Option<&ModelBudget>) -> i64 {
    if job["kind"] == "evaluate" {
        return 120_000;
    }
    budget.map_or(LEGACY_AGENT_MS, ModelBudget::attempt_ceiling_ms)
}

/// The no-progress window, present only for budgeted agent attempts.
fn idle_ms(job: &Value, budget: Option<&ModelBudget>) -> Option<i64> {
    (job["kind"] == "agent")
        .then_some(budget)
        .flatten()
        .map(ModelBudget::idle_timeout_ms)
}

/// Total job deadline from a dispatch deadline: dispatch wait, boot and the attempt ceiling.
pub(in crate::commands) fn job_deadline(
    dispatch: i64,
    job: &Value,
    budget: Option<&ModelBudget>,
) -> Result<i64> {
    dispatch
        .checked_add(ceiling_ms(job, budget))
        .and_then(|value| value.checked_add(BOOT_MS))
        .ok_or_else(|| bad("Attempt deadline overflow"))
}

pub(in crate::commands) fn claimed(
    j: &mut Value,
    budget: Option<&ModelBudget>,
    now: i64,
) -> Result<()> {
    let deadline = number(j, "deadline")?;
    let ceiling = (now + BOOT_MS + ceiling_ms(j, budget)).min(deadline);
    let rolling = match idle_ms(j, budget) {
        Some(idle) => (now + BOOT_MS + idle + PROGRESS_GRACE_MS).min(ceiling),
        None => ceiling,
    };
    j["attempt_ceiling_at"] = json!(ceiling);
    j["attempt_deadline"] = json!(rolling);
    j["progress_at"] = json!(now);
    j["model_request_at"] = Value::Null;
    j["model_response_at"] = Value::Null;
    j["lease_until"] = json!((now + BOOT_MS).min(rolling));
    Ok(())
}

/// Container readiness starts the attempt clock; the ceiling never extends past the job deadline.
pub(in crate::commands) fn runtime_ready(
    j: &mut Value,
    budget: Option<&ModelBudget>,
    now: i64,
) -> Result<()> {
    let ceiling = (now + ceiling_ms(j, budget)).min(number(j, "deadline")?);
    j["attempt_ceiling_at"] = json!(ceiling);
    j["attempt_deadline"] = json!(match idle_ms(j, budget) {
        Some(idle) => (now + idle + PROGRESS_GRACE_MS).min(ceiling),
        None => ceiling,
    });
    j["progress_at"] = json!(now);
    Ok(())
}

/// Ledger-observed model activity since the last recorded progress, or a request in flight.
pub(in crate::commands) fn model_active(j: &Value, now: i64) -> bool {
    let progress = j["progress_at"].as_i64().unwrap_or(0);
    let request = j["model_request_at"].as_i64();
    let response = j["model_response_at"].as_i64();
    let in_flight = request.is_some_and(|started| {
        started > response.unwrap_or(0)
            && now.saturating_sub(started) < MODEL_REQUEST_PROGRESS_CAP_MS
    });
    in_flight || request.is_some_and(|t| t > progress) || response.is_some_and(|t| t > progress)
}

/// Watchdog supervisors send an explicit `active` boolean. Heartbeats without it (Worker source
/// preparation, or a supervisor image from before the watchdog) keep extending to the ceiling;
/// such a supervisor still enforces its own fixed wall clock, so rollout order cannot fence it early.
pub(in crate::commands) fn supervisor_active(c: &Value) -> bool {
    c["active"].as_bool().unwrap_or(true)
}

/// Extend the rolling deadline on progress, bounded by the hard ceiling. Returns whether the
/// ledger itself observed model activity, so the supervisor can count provider waits as progress.
pub(in crate::commands) fn heartbeat(
    j: &mut Value,
    budget: Option<&ModelBudget>,
    supervisor_active: bool,
    now: i64,
) -> Result<bool> {
    let model = model_active(j, now);
    let Some(idle) = idle_ms(j, budget) else {
        return Ok(model);
    };
    // Before readiness, every trusted heartbeat is boot or source-preparation progress.
    if supervisor_active || model || j["runtime_started_at"].is_null() {
        let ceiling = j["attempt_ceiling_at"]
            .as_i64()
            .unwrap_or(number(j, "attempt_deadline")?);
        let extended = (now + idle + PROGRESS_GRACE_MS).min(ceiling);
        j["attempt_deadline"] = json!(number(j, "attempt_deadline")?.max(extended));
        j["progress_at"] = json!(now);
    }
    Ok(model)
}
