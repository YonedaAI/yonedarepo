//! The supervisor applies the same frozen model-group limits as the ledger.
use serde_json::Value;
use yoneda_agents_core::{Error, Result, model_budget::ModelBudget};

pub(crate) fn model_budget(job: &Value) -> Result<Option<ModelBudget>> {
    let execution = &job["payload"]["execution"];
    let run = &job["payload"]["run"];
    let source = if execution["comparison_approval_id"].is_string() {
        let approval = &run["comparison"]["approval"];
        if approval["id"] != execution["comparison_approval_id"] {
            return Err(Error::new("FENCED", "Comparison budget approval changed"));
        }
        Some(approval.get("model_budget_configs").ok_or_else(|| {
            Error::new(
                "FENCED",
                "Comparison model budget configurations are missing",
            )
        })?)
    } else {
        run.get("model_budgets")
    };
    let Some(value) = source else {
        return Ok(None);
    };
    let budgets: Vec<ModelBudget> = serde_json::from_value(value.clone())
        .map_err(|_| Error::new("FENCED", "Invalid frozen model budget"))?;
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
    // Capture and publication do not run a model. Their execution metadata identifies
    // source provenance, without carrying the coding attempt's model approval.
    if job["kind"] == "capture" || job["kind"] == "publish" {
        return Ok(570_000);
    }
    let Some(budget) = model_budget(job)? else {
        return Ok(570_000);
    };
    // Agent cleanup may consume two seconds; retain an unchanged absolute deadline while
    // reserving ten seconds for process termination, a two-second evidence upload and failure.
    // Other job kinds retain their existing five-second callback window.
    let report_window = if job["kind"] == "agent" {
        10_000
    } else {
        5_000
    };
    u64::try_from(budget.max_execution_ms - report_window)
        .map_err(|_| Error::new("INVALID_INPUT", "Invalid model execution duration"))
}

#[cfg(test)]
#[path = "tests/execution_phases.rs"]
mod tests;
