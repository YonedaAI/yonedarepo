use crate::storage::*;
use serde_json::Value;
use std::collections::BTreeSet;
use yoneda_agents_core::{Error, Result, model_budget::ModelBudget};

pub(super) fn freeze(c: &Value) -> Result<Option<Vec<ModelBudget>>> {
    let mut approved_agents = if c["adaptive_team"].is_object() {
        c["_approved_model_pool"].clone()
    } else {
        c["agents"].clone()
    };
    if c["comparison"].is_object() {
        approved_agents
            .as_array_mut()
            .ok_or_else(|| bad("Missing comparison builders"))?
            .push(c["_comparison_reviewer"].clone());
    }
    let agents = approved_agents
        .as_array()
        .ok_or_else(|| bad("Missing scheduled agents"))?;
    let defaults = agents
        .iter()
        .map(|agent| {
            Ok((
                (string(agent, "provider")?, string(agent, "model")?),
                serde_json::json!({"provider":agent["provider"],"model":agent["model"],
            "max_requests":null,"max_output_tokens":4096,"max_execution_ms":600000,
            "spend_limit_microusd":null,"pricing":null}),
            ))
        })
        .collect::<Result<std::collections::BTreeMap<_, _>>>()?;
    let defaults = serde_json::json!(defaults.into_values().collect::<Vec<_>>());
    let budgets: Vec<ModelBudget> =
        serde_json::from_value(c.get("model_budgets").unwrap_or(&defaults).clone())
            .map_err(|e| bad(&e.to_string()))?;
    let mut keys = BTreeSet::new();
    for budget in &budgets {
        budget.validate_configuration()?;
        if !keys.insert((budget.provider.clone(), budget.model.clone())) {
            return Err(bad("Duplicate provider/model budget"));
        }
    }
    let agents = approved_agents
        .as_array()
        .ok_or_else(|| bad("Missing scheduled agents"))?;
    let scheduled: BTreeSet<_> = agents
        .iter()
        .map(|a| Ok((string(a, "provider")?, string(a, "model")?)))
        .collect::<Result<_>>()?;
    if keys != scheduled {
        return Err(bad(
            "Model budgets must exactly match the scheduled provider/model groups",
        ));
    }
    Ok(Some(budgets))
}

pub(super) fn group(run: &Value, execution: &Value) -> Result<Option<(usize, ModelBudget)>> {
    if run.get("model_budgets").is_none() {
        return Ok(None);
    }
    let value = super::comparison::budget_values(run, Some(execution))?;
    let budgets: Vec<ModelBudget> =
        serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?;
    let provider = string(execution, "provider")?;
    let model = string(execution, "model")?;
    if execution["budget"]["provider"] != provider || execution["budget"]["model"] != model {
        return Err(Error::new(
            "FENCED",
            "Execution model budget identity changed",
        ));
    }
    let result = budgets
        .into_iter()
        .enumerate()
        .find(|(_, b)| b.provider == provider && b.model == model)
        .ok_or_else(|| Error::new("FENCED", "Execution has no approved model budget"))?;
    Ok(Some(result))
}

pub(super) fn for_job<S: SqlStore>(db: &S, job: &Value) -> Result<Option<ModelBudget>> {
    if job["kind"] != "agent" {
        return Ok(None);
    }
    let execution = &job["payload"]["execution"];
    let run = get(db, "runs", &string(execution, "run_id")?)?;
    Ok(group(&run, execution)?.map(|(_, budget)| budget))
}
