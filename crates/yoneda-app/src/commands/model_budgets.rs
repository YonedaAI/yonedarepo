use crate::storage::*;
use serde_json::Value;
use std::collections::BTreeSet;
use yoneda_core::{Error, Result, model_budget::ModelBudget};

pub(super) fn freeze(c: &Value, general: bool) -> Result<Option<Vec<ModelBudget>>> {
    let Some(value) = c.get("model_budgets") else {
        return Ok(None);
    };
    if !general {
        return Err(Error::new(
            "FORBIDDEN",
            "Model budgets require a hosted coding run",
        ));
    }
    let budgets: Vec<ModelBudget> =
        serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?;
    let mut keys = BTreeSet::new();
    for budget in &budgets {
        budget.validate_configuration()?;
        if !keys.insert((budget.provider.clone(), budget.model.clone())) {
            return Err(bad("Duplicate provider/model budget"));
        }
    }
    let agents = c["agents"]
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
    let Some(value) = run.get("model_budgets") else {
        return Ok(None);
    };
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
