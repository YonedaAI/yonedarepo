//! Metered spend of a `sandbox-cli-v1` attempt. The stock CLI's model traffic goes through the
//! Worker's `SandboxOutbound`, which reads the provider's own usage from each finished response
//! and records it here once per response (`sandbox_usage`). Before each new model request it
//! asks `sandbox_budget`; a request is refused only once the run's approved spend for that
//! provider/model group is actually used up, never by time or by an advance estimate.
//!
//! Usage is priced at the run's frozen budget rates (the provider registry's rates, approved
//! with the run). Recording does not need a live lease: spend that happened is kept even when
//! the attempt was cancelled or fenced while the response streamed.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::model_budget::MAX_SAFE_BUDGET_INTEGER;
use yoneda_agents_core::{Error, Result};

/// Largest token count one response may report (far above any model's context window).
const MAX_RESPONSE_TOKENS: i64 = 100_000_000;

/// The attempt's sandbox job and the reported epoch: the current one or an earlier one whose
/// response was still streaming when cancellation or recovery moved the epoch on.
fn sandbox_job<S: SqlStore>(db: &S, c: &Value) -> Result<(Value, i64)> {
    let job = get(db, "jobs", &string(c, "job_id")?)?;
    if job["sandbox"] != true || job["kind"] != "agent" {
        return Err(Error::new("FORBIDDEN", "Not a sandbox attempt"));
    }
    let epoch = number(c, "epoch")?;
    if !(1..=number(&job, "epoch")?).contains(&epoch) {
        return Err(Error::new("FENCED", "No such attempt epoch"));
    }
    Ok((job, epoch))
}

fn tokens(c: &Value, key: &str) -> Result<i64> {
    match c.get(key) {
        None | Some(Value::Null) => Ok(0),
        Some(value) => value
            .as_i64()
            .filter(|n| (0..=MAX_RESPONSE_TOKENS).contains(n))
            .ok_or_else(|| bad(&format!("{key} must be a token count"))),
    }
}

/// Whether the run's approved spend for this attempt's model group is used up.
fn spent(budget: &yoneda_agents_core::model_budget::ModelBudget) -> bool {
    budget
        .spend_limit_microusd
        .is_some_and(|limit| budget.charged_microusd >= limit)
}

/// Read before each model request: `exhausted` refuses it. A finished, cancelled or superseded
/// attempt makes no further requests.
pub(super) fn budget<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let job = active(db, c, now)?;
    if job["sandbox"] != true {
        return Err(Error::new("FORBIDDEN", "Not a sandbox attempt"));
    }
    let execution = &job["payload"]["execution"];
    let run = get(db, "runs", &string(execution, "run_id")?)?;
    Ok(match super::model_budgets::group(&run, execution)? {
        Some((_, budget)) => json!({"exhausted":spent(&budget),"provider":budget.provider,
            "model":budget.model,"charged_microusd":budget.charged_microusd,
            "spend_limit_microusd":budget.spend_limit_microusd}),
        None => json!({"exhausted":false}),
    })
}

/// One finished model response's reported usage, recorded once (`response_id` is the
/// idempotency key: a repeated report with the same counts is a no-op).
pub(super) fn record<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let (job, epoch) = sandbox_job(db, c)?;
    let response = string(c, "response_id")?;
    if response.is_empty()
        || response.len() > 64
        || !response
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(bad("response_id must be a short identifier"));
    }
    let usage = c.get("usage").ok_or_else(|| bad("Missing usage"))?;
    let input = tokens(usage, "input_tokens")?;
    let cache_read = tokens(usage, "cache_read_input_tokens")?;
    let cache_write = tokens(usage, "cache_creation_input_tokens")?;
    let output = tokens(usage, "output_tokens")?;
    let jid = string(&job, "id")?;
    let id = format!(
        "sandbox-usage:{}",
        yoneda_agents_core::fingerprint(&json!({"job_id":jid,"epoch":epoch,"response":response}))?
    );
    let counts = json!({"input_tokens":input,"cache_read_input_tokens":cache_read,
        "cache_creation_input_tokens":cache_write,"output_tokens":output});
    if let Ok(existing) = get(db, "model_reservations", &id) {
        if existing["usage"] != counts {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Metered usage for this response is immutable",
            ));
        }
        return Ok(existing);
    }
    let execution = &job["payload"]["execution"];
    let rid = string(execution, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    // Cache reads and writes are input tokens at the approved input rate (conservative).
    let priced_input = input
        .checked_add(cache_read)
        .and_then(|n| n.checked_add(cache_write))
        .ok_or_else(|| bad("Token count overflow"))?;
    let (charged, budget) = match super::model_budgets::group(&run, execution)? {
        Some((index, mut budget)) => {
            let amount = budget.charge(priced_input, output)?;
            budget.requests += 1;
            budget.charged_microusd = budget
                .charged_microusd
                .checked_add(amount)
                .filter(|v| *v <= MAX_SAFE_BUDGET_INTEGER)
                .ok_or_else(|| bad("Model budget amount overflow"))?;
            super::comparison::put_budget(&mut run, execution, index, json!(budget))?;
            (amount, Some(budget))
        }
        None => (0, None),
    };
    let group = format!(
        "{}/{}",
        string(execution, "provider")?,
        string(execution, "model")?
    );
    add_usage(&mut run["metered_usage"][&group], &counts, charged)?;
    save(db, "runs", &rid, &run)?;
    let mut e = get(db, "executions", &string(execution, "id")?)?;
    add_usage(&mut e["metered_usage"], &counts, charged)?;
    save_execution(db, &e, now)?;
    let record = json!({"id":id,"kind":"sandbox_metered","run_id":rid,"job_id":jid,"epoch":epoch,
        "execution_id":e["id"],"provider":execution["provider"],"model":execution["model"],
        "usage":counts,"charged_microusd":charged,"status":"settled","created_at":now});
    create(db, "model_reservations", &id, &record)?;
    let exhausted = budget.as_ref().is_some_and(spent);
    event(
        db,
        "model.usage_metered",
        now,
        json!({"run_id":rid,"execution_id":e["id"],"usage":counts,"charged_microusd":charged,
            "model_budget":budget,"exhausted":exhausted}),
    )?;
    Ok(
        json!({"id":id,"charged_microusd":charged,"model_budget":budget,"exhausted":exhausted,
        "metered_usage":e["metered_usage"]}),
    )
}

/// Adds one response to running totals: `{requests, <token counts>, charged_microusd}`.
fn add_usage(total: &mut Value, counts: &Value, charged: i64) -> Result<()> {
    let add = |total: &Value, key: &str, n: i64| {
        total[key]
            .as_i64()
            .unwrap_or(0)
            .checked_add(n)
            .ok_or_else(|| bad("Metered usage overflow"))
    };
    let mut next = json!({"requests":add(total, "requests", 1)?,
        "charged_microusd":add(total, "charged_microusd", charged)?});
    for key in [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
    ] {
        next[key] = json!(add(total, key, counts[key].as_i64().unwrap_or(0))?);
    }
    *total = next;
    Ok(())
}

#[cfg(test)]
#[path = "sandbox_usage_tests.rs"]
mod tests;
