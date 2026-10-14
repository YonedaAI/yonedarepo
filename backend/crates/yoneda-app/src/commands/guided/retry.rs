//! Step-level retry. A step whose latest attempt ended without complete evidence may start a
//! fresh attempt; prior run ids stay in session history but are no longer judged.
use super::*;

/// Bounds operator-funded spend from repeated retries of one step.
const MAX_ATTEMPTS: u64 = 5;

/// The untrusted `retry` flag is absent or a JSON boolean; anything else is rejected.
pub(super) fn requested(c: &Value) -> Result<bool> {
    match c.get("retry") {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(flag)) => Ok(*flag),
        Some(_) => Err(bad("Guided retry must be a boolean")),
    }
}

/// The attempt number recorded for a saved step; sessions created before retries are attempt 1.
pub(super) fn attempt(saved: &Value) -> u64 {
    saved["attempt"].as_u64().filter(|n| *n >= 1).unwrap_or(1)
}

/// Deterministic run identity. The first attempt keeps the original unsuffixed form so
/// existing sessions and approvals remain valid; the Worker preparation mirrors this.
pub(super) fn run_id(session_id: &str, step: &str, ordinal: usize, attempt: u64) -> String {
    let prefix = &yoneda_core::digest(session_id.as_bytes())[..24];
    if attempt <= 1 {
        format!("guide-{prefix}-{step}-{ordinal}")
    } else {
        format!("guide-{prefix}-{step}-{ordinal}-r{attempt}")
    }
}

fn refused(message: &str) -> Error {
    Error::new("GUIDED_STEP_NOT_RETRYABLE", message)
}

/// Retry only a step whose computed status is `needs_attention`, whose every run is terminal
/// and which has no queued or running job left.
pub(super) fn check<S: SqlStore>(
    db: &S,
    session: &Value,
    index: usize,
    view: &Value,
) -> Result<()> {
    if view["steps"][index]["status"] != "needs_attention" {
        return Err(refused("Only a step that needs attention can be retried"));
    }
    let saved = &session["steps"][index];
    if attempt(saved) >= MAX_ATTEMPTS {
        return Err(refused("This step reached its retry limit"));
    }
    let ids = saved["run_ids"].as_array().cloned().unwrap_or_default();
    if ids.is_empty() {
        return Err(refused("Only a started step can be retried"));
    }
    for id in &ids {
        let id = id.as_str().ok_or_else(|| bad("Invalid guided run"))?;
        let run = get(db, "runs", id)?;
        if !evidence::TERMINAL.contains(&run["status"].as_str().unwrap_or_default()) {
            return Err(refused("Wait for every run in this step to finish"));
        }
        if run_jobs(db, id)?
            .iter()
            .any(|job| job["status"] == "queued" || job["status"] == "running")
        {
            return Err(refused("Wait for this step's remaining work to stop"));
        }
    }
    Ok(())
}

/// Moves the latest attempt's run ids into history and returns the new attempt number.
pub(super) fn advance(session: &mut Value, index: usize) -> u64 {
    let saved = &mut session["steps"][index];
    let next = attempt(saved) + 1;
    let mut history = saved["previous_run_ids"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    history.extend(saved["run_ids"].as_array().cloned().unwrap_or_default());
    saved["previous_run_ids"] = json!(history);
    saved["run_ids"] = json!([]);
    saved["attempt"] = json!(next);
    next
}
