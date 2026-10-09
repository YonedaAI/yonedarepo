//! Monetary ceilings commit before provider I/O; unknown usage retains its reservation.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result, agents::MAX_RUN_MODEL_REQUESTS, model_budget::MAX_SAFE_BUDGET_INTEGER,
};

pub(super) fn reserve<S: SqlStore>(db: &S, c: &Value, mut job: Value, now: i64) -> Result<Value> {
    if job["external"] == true {
        return Err(Error::new(
            "FORBIDDEN",
            "External agents cannot reserve hosted inference",
        ));
    }
    let execution = &job["payload"]["execution"];
    let rid = string(execution, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    let group = super::model_budgets::group(&run, execution)?;
    let request_number = job["model_requests"]
        .as_i64()
        .unwrap_or_default()
        .checked_add(1)
        .ok_or_else(|| bad("Request count overflow"))?;
    if group.is_none() && request_number > 24 {
        return Err(Error::new("RESOURCE_LIMIT", "model request limit reached"));
    }
    let used = match run["model_requests"].as_i64() {
        Some(used) => used,
        None => run_jobs(db, &rid)?
            .iter()
            .map(|j| j["model_requests"].as_i64().unwrap_or_default())
            .sum(),
    };
    let total = used
        .checked_add(1)
        .ok_or_else(|| bad("Run model request overflow"))?;
    let legacy = run["request_limits"] != "optional-v1";
    if legacy && total > MAX_RUN_MODEL_REQUESTS {
        return Err(Error::new(
            "RESOURCE_LIMIT",
            "Shared run model request limit reached",
        ));
    }
    let mut response = json!({"number":request_number,"run_number":total,"run_limit":if legacy {json!(MAX_RUN_MODEL_REQUESTS)} else {Value::Null}});
    if let Some((index, mut budget)) = group {
        if budget
            .max_requests
            .is_some_and(|limit| budget.requests >= limit)
        {
            return Err(Error::new(
                "MODEL_REQUEST_LIMIT",
                "This provider/model group exhausted its approved request budget",
            ));
        }
        let input_bytes = number(c, "input_bytes")?;
        let output_tokens = number(c, "output_tokens")?;
        let count_only = match c.get("count_only") {
            None => false,
            Some(value) => value
                .as_bool()
                .ok_or_else(|| bad("Invalid count-only marker"))?,
        };
        let (amount, input_tokens) =
            budget.reserve_charge(input_bytes, output_tokens, count_only)?;
        let charged = budget
            .charged_microusd
            .checked_add(amount)
            .filter(|v| *v <= MAX_SAFE_BUDGET_INTEGER)
            .ok_or_else(|| bad("Model budget amount overflow"))?;
        if budget
            .spend_limit_microusd
            .is_some_and(|limit| charged > limit)
        {
            return Err(Error::new(
                "MODEL_SPEND_LIMIT",
                "This provider/model group has insufficient approved spend remaining for the conservative request ceiling",
            ));
        }
        budget.requests += 1;
        budget.charged_microusd = charged;
        run["model_budgets"][index] = json!(budget);
        let jid = string(&job, "id")?;
        let epoch = number(&job, "epoch")?;
        let key =
            yoneda_core::fingerprint(&json!({"job_id":jid,"epoch":epoch,"number":request_number}))?;
        let id = format!("model-request:{key}");
        let reservation = json!({"id":id,"run_id":rid,"job_id":jid,"epoch":epoch,
            "provider":budget.provider,"model":budget.model,"reserved_microusd":amount,
            "charged_microusd":amount,"input_token_ceiling":input_tokens,"output_token_ceiling":output_tokens,
            "pricing":budget.pricing,"status":"reserved","created_at":now,"count_only":count_only});
        create(db, "model_reservations", &id, &reservation)?;
        response["reservation_id"] = json!(id);
        response["reservation_microusd"] = json!(amount);
        response["model_budget"] = json!(budget);
    }
    run["model_requests"] = json!(total);
    job["model_requests"] = json!(request_number);
    save(db, "runs", &rid, &run)?;
    save(db, "jobs", &string(&job, "id")?, &job)?;
    if response.get("reservation_id").is_some() {
        event(db, "model.request_reserved", now, response.clone())?;
    }
    Ok(response)
}

/// Authenticated adapters report provider usage. Lease expiry does not erase spend.
pub(super) fn settle<S: SqlStore>(db: &S, c: Value, now: i64) -> Result<Value> {
    let id = string(&c, "reservation_id")?;
    let mut reservation = get(db, "model_reservations", &id)?;
    if reservation["job_id"] != string(&c, "job_id")?
        || reservation["epoch"] != number(&c, "epoch")?
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Model reservation belongs to another attempt",
        ));
    }
    let input_tokens = number(&c, "input_tokens")?;
    let output_tokens = number(&c, "output_tokens")?;
    if !(0..=number(&reservation, "input_token_ceiling")?).contains(&input_tokens)
        || !(0..=number(&reservation, "output_token_ceiling")?).contains(&output_tokens)
    {
        return Err(bad("Provider usage exceeds the reserved token ceilings"));
    }
    let jid = string(&reservation, "job_id")?;
    let job = get(db, "jobs", &jid)?;
    let rid = string(&reservation, "run_id")?;
    let mut run = get(db, "runs", &rid)?;
    let (index, mut budget) = super::model_budgets::group(&run, &job["payload"]["execution"])?
        .ok_or_else(|| Error::new("FENCED", "Model reservation has no approved budget"))?;
    if reservation["provider"] != budget.provider
        || reservation["model"] != budget.model
        || reservation["pricing"] != json!(budget.pricing)
    {
        return Err(Error::new(
            "FENCED",
            "Model reservation configuration changed",
        ));
    }
    let amount = budget.charge(input_tokens, output_tokens)?;
    if amount > number(&reservation, "reserved_microusd")? {
        return Err(bad("Settlement exceeds the monetary reservation"));
    }
    if reservation["status"] == "settled" {
        if reservation["input_tokens"] != input_tokens
            || reservation["output_tokens"] != output_tokens
        {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Model usage settlement is immutable",
            ));
        }
        return Ok(reservation);
    }
    let refund = number(&reservation, "charged_microusd")? - amount;
    budget.charged_microusd = budget
        .charged_microusd
        .checked_sub(refund)
        .filter(|v| *v >= 0)
        .ok_or_else(|| bad("Model spend ledger underflow"))?;
    run["model_budgets"][index] = json!(budget);
    reservation["charged_microusd"] = json!(amount);
    reservation["input_tokens"] = json!(input_tokens);
    reservation["output_tokens"] = json!(output_tokens);
    reservation["status"] = json!("settled");
    reservation["settled_at"] = json!(now);
    save(db, "model_reservations", &id, &reservation)?;
    save(db, "runs", &rid, &run)?;
    event(
        db,
        "model.request_settled",
        now,
        json!({"reservation":reservation,"refund_microusd":refund,"model_budget":budget}),
    )?;
    Ok(reservation)
}
