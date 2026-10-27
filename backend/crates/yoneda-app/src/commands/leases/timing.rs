//! The claimed attempt's clock: a hard `attempt_ceiling_at` safety net and an
//! `attempt_deadline`. Sandbox attempts and checks then replace both with their own lease
//! (`sandbox::claimed`, `sandbox::claimed_check`).
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Result, model_budget::ModelBudget};

/// Covers the 20 s heartbeat interval plus the supervisor's 10 s failure-report window.
pub(in crate::commands) const PROGRESS_GRACE_MS: i64 = 60_000;
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
