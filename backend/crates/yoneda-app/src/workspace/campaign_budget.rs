//! Atomic aggregate, bucket and chain reservations. Lost usage remains fully charged.
use super::campaign::{approval, identifier, key, require};
use super::campaign_runs::run_key;
use super::*;
use crate::storage::{create, number};
use yoneda_agents_core::model_budget::ModelBudget;

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, now: i64) -> Result<Value> {
    let reservation_id = identifier(c, "reservation_id")?;
    let reservation_key = format!("campaign-reservation:{reservation_id}");
    let repo = identifier(c, "repo_id")?;
    let run = identifier(c, "run_id")?;
    let binding = get(db, TABLE, &run_key(&repo, &run))?;
    let id = string(&binding, "id")?;
    let mut bucket = string(&binding, "bucket")?;
    let chain = string(&binding, "chain_id")?;
    let mut state = get(db, TABLE, &key(&id))?;
    let approved = approval(db, &id, number(&binding, "version")?)?;
    let chain_key = format!("campaign:{id}:chain:{chain}");
    let mut chain_state = get(db, TABLE, &chain_key)?;
    let provider = string(c, "provider")?;
    let model = string(c, "model")?;
    if model == "claude-opus-5-5" && !binding["repair_escalation"].is_null() {
        bucket = "opus".to_owned();
    }
    let budgets: Vec<ModelBudget> = serde_json::from_value(binding["model_budgets"].clone())
        .map_err(|e| bad(&e.to_string()))?;
    let budget = budgets
        .iter()
        .find(|b| b.provider == provider && b.model == model)
        .ok_or_else(|| Error::new("FORBIDDEN", "Provider outside bound campaign run"))?;
    let group = format!("{provider}/{model}");
    if c["op"] == "campaign_reserve" {
        require(db, &id, now)?;
        let input = number(c, "input_bytes")?;
        let output = number(c, "output_tokens")?;
        let count_only = c["count_only"]
            .as_bool()
            .ok_or_else(|| bad("Count-only marker required"))?;
        let (amount, input_ceiling) = budget.reserve_charge(input, output, count_only)?;
        if number(c, "amount")? != amount {
            return Err(bad("Campaign reservation differs from run ceiling"));
        }
        let identity = json!({"repo_id":repo,"run_id":run,"provider":provider,"model":model,"input_bytes":input,"output_tokens":output,"count_only":count_only,"amount":amount,"binding":binding});
        let rows = db.query(
            "SELECT payload FROM workspace_records WHERE id=?",
            &[json!(reservation_key)],
        )?;
        if !rows.is_empty() {
            let existing = get(db, TABLE, &reservation_key)?;
            if existing["identity"] != identity {
                return Err(Error::new(
                    "IDEMPOTENCY_CONFLICT",
                    "Campaign reservation ID reused with different identity",
                ));
            }
            return Ok(existing);
        }
        let charged = number(&state, "charged_microusd")?
            .checked_add(amount)
            .ok_or_else(|| bad("Campaign overflow"))?;
        let bucket_charge = number(&state["charged"], &bucket)?
            .checked_add(amount)
            .ok_or_else(|| bad("Bucket overflow"))?;
        let chain_charge = number(&chain_state, "charged_microusd")?
            .checked_add(amount)
            .ok_or_else(|| bad("Chain overflow"))?;
        let mut model_state = chain_state["models"][&group].clone();
        if model_state.is_null() {
            model_state = json!({"requests":0,"charged_microusd":0});
        }
        let requests = number(&model_state, "requests")? + 1;
        let model_charge = number(&model_state, "charged_microusd")?
            .checked_add(amount)
            .ok_or_else(|| bad("Model spend overflow"))?;
        if charged > number(&state, "limit_microusd")?
            || bucket_charge > number(&state["buckets"], &bucket)?
            || chain_charge > number(&approved, "chain_limit_microusd")?
            || budget
                .spend_limit_microusd
                .is_some_and(|v| model_charge > v)
        {
            return Err(Error::new(
                "CAMPAIGN_EXHAUSTED",
                "Campaign, bucket, chain or model allowance exhausted",
            ));
        }
        if budget.max_requests.is_some_and(|v| requests > v) {
            return Err(Error::new(
                "CAMPAIGN_MODEL_REQUEST_LIMIT",
                "This model exhausted its original shared campaign request allowance",
            ));
        }
        state["charged_microusd"] = json!(charged);
        state["charged"][&bucket] = json!(bucket_charge);
        chain_state["charged_microusd"] = json!(chain_charge);
        model_state["requests"] = json!(requests);
        model_state["charged_microusd"] = json!(model_charge);
        chain_state["models"][&group] = model_state;
        let reservation = json!({"id":reservation_id,"identity":identity,"charged_microusd":amount,"input_token_ceiling":input_ceiling,"status":"reserved","created_at":now});
        create(db, TABLE, &reservation_key, &reservation)?;
        put(db, &key(&id), &state)?;
        put(db, &chain_key, &chain_state)?;
        audit(
            db,
            "campaign.reserved",
            now,
            json!({"id":id,"reservation_id":reservation_id,"amount":amount,"run_id":run}),
        )?;
        return Ok(reservation);
    }
    let mut reservation = get(db, TABLE, &reservation_key)?;
    if reservation["identity"]["binding"] != binding
        || reservation["identity"]["provider"] != provider
        || reservation["identity"]["model"] != model
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Settlement belongs to another campaign attempt",
        ));
    }
    let input = number(c, "input_tokens")?;
    let output = number(c, "output_tokens")?;
    if !(0..=number(&reservation, "input_token_ceiling")?).contains(&input)
        || !(0..=number(&reservation["identity"], "output_tokens")?).contains(&output)
    {
        return Err(bad("Usage exceeds campaign reservation"));
    }
    let amount = budget.charge(input, output)?;
    if amount > number(&reservation["identity"], "amount")? {
        return Err(bad("Charge exceeds reserved amount"));
    }
    if reservation["status"] == "settled" {
        if reservation["input_tokens"] != input || reservation["output_tokens"] != output {
            return Err(Error::new(
                "IDEMPOTENCY_CONFLICT",
                "Campaign settlement is immutable",
            ));
        }
        return Ok(reservation);
    }
    let refund = number(&reservation, "charged_microusd")? - amount;
    fn subtract(value: &mut Value, field: &str, refund: i64) -> Result<()> {
        value[field] = json!(
            number(value, field)?
                .checked_sub(refund)
                .filter(|v| *v >= 0)
                .ok_or_else(|| bad("Campaign spend underflow"))?
        );
        Ok(())
    }
    subtract(&mut state, "charged_microusd", refund)?;
    subtract(&mut state["charged"], &bucket, refund)?;
    subtract(&mut chain_state, "charged_microusd", refund)?;
    subtract(
        &mut chain_state["models"][&group],
        "charged_microusd",
        refund,
    )?;
    reservation["charged_microusd"] = json!(amount);
    reservation["status"] = json!("settled");
    reservation["input_tokens"] = json!(input);
    reservation["output_tokens"] = json!(output);
    put(db, &reservation_key, &reservation)?;
    put(db, &key(&id), &state)?;
    put(db, &chain_key, &chain_state)?;
    audit(
        db,
        "campaign.settled",
        now,
        json!({"id":id,"reservation_id":reservation_id,"amount":amount}),
    )?;
    Ok(reservation)
}
