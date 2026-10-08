//! The supervisor applies the same frozen model-group limits as the ledger.
use serde_json::Value;
use yoneda_core::{Error, Result, model_budget::ModelBudget};

pub(crate) fn model_budget(job: &Value) -> Result<Option<ModelBudget>> {
    let Some(value) = job["payload"]["run"].get("model_budgets") else {
        return Ok(None);
    };
    let budgets: Vec<ModelBudget> = serde_json::from_value(value.clone())
        .map_err(|_| Error::new("FENCED", "Invalid frozen model budget"))?;
    let execution = &job["payload"]["execution"];
    let provider = execution["provider"].as_str();
    let model = execution["model"].as_str();
    if execution["budget"]["provider"].as_str() != provider
        || execution["budget"]["model"].as_str() != model
    {
        return Err(Error::new(
            "FENCED",
            "Execution model budget identity changed",
        ));
    }
    let mut budget = budgets
        .into_iter()
        .find(|budget| {
            Some(budget.provider.as_str()) == provider && Some(budget.model.as_str()) == model
        })
        .ok_or_else(|| Error::new("FENCED", "No model budget matches this execution"))?;
    // Usage in the frozen payload is historical; only configuration controls the child.
    budget.requests = 0;
    budget.charged_microusd = 0;
    budget.validate_configuration()?;
    Ok(Some(budget))
}

pub(crate) fn timeout_ms(job: &Value) -> Result<u64> {
    if job["kind"] == "evaluate" {
        return Ok(110_000);
    }
    let Some(budget) = model_budget(job)? else {
        return Ok(570_000);
    };
    // Leave time to record failure evidence before the authoritative lease expires.
    u64::try_from(budget.max_execution_ms - 5_000)
        .map_err(|_| Error::new("INVALID_INPUT", "Invalid model execution duration"))
}
