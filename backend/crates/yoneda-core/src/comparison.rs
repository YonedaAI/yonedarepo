//! Compare approval identity and bounded logical review authority.
use crate::{Error, Result};
use serde_json::{Value, json};
pub const MAX_REVIEW_REQUESTS: i64 = 12;
pub const MAX_REPAIR_ROUNDS: i64 = 2;
pub const MAX_LOGICAL_EXECUTIONS: i64 = 7;
pub const MAX_MODEL_REQUESTS: i64 = 144;

pub fn configurations(value: &Value) -> Result<Value> {
    let budgets = value
        .as_array()
        .ok_or_else(|| Error::new("FENCED", "Missing comparison budgets"))?;
    Ok(json!(
        budgets
            .iter()
            .map(|b| {
                let mut config = b.clone();
                if let Some(m) = config.as_object_mut() {
                    m.remove("requests");
                    m.remove("charged_microusd");
                }
                config
            })
            .collect::<Vec<_>>()
    ))
}
pub fn validate_approval(run: &Value) -> Result<()> {
    let approval = &run["comparison"]["approval"];
    let mut bound = approval.clone();
    let digest = bound.as_object_mut().and_then(|m| m.remove("digest"));
    if approval["version"] != 1
        || digest.as_ref().and_then(Value::as_str) != Some(crate::fingerprint(&bound)?.as_str())
        || approval["builders"] != run["agents"]
        || approval["intent"] != run["intent"]
        || approval["criteria"] != run["criteria"]
        || approval
            .get("original_policy")
            .unwrap_or(&approval["policy"])
            != &run["policy"]
        || approval["policy"]
            != *run["comparison"]
                .get("approved_policy")
                .unwrap_or(&run["policy"])
        || approval["context"] != run["context"]
        || approval["base"] != run["base"]
        || approval["branch_id"] != run["working_branch_id"]
        || approval["original_branch_version"] != run["working_branch_version"]
        || approval
            .get("context_records")
            .is_some_and(|v| *v != run["context_records"])
        || approval["max_review_requests"] != MAX_REVIEW_REQUESTS
        || approval["max_repair_rounds"] != MAX_REPAIR_ROUNDS
        || approval["max_logical_executions"] != MAX_LOGICAL_EXECUTIONS
    {
        return Err(Error::new("FENCED", "Frozen comparison approval changed"));
    }
    let budgets = if approval["budget_scope"] == "comparison_approval" {
        &run["comparison"]["model_budgets"]
    } else {
        &run["model_budgets"]
    };
    if configurations(budgets)? != approval["model_budget_configs"] {
        return Err(Error::new(
            "FENCED",
            "Comparison budget configuration changed",
        ));
    }
    Ok(())
}
pub fn validate_reviewer(run: &Value, execution: &Value) -> Result<()> {
    validate_approval(run)?;
    let a = &run["comparison"]["approval"];
    let reviewer = &a["reviewer"];
    if execution["comparison_approval_id"] != a["id"]
        || execution["comparison_role"] != "reviewer"
        || execution["role"] != "reviewer"
        || !execution["agent_index"].is_null()
        || execution["run_id"] != run["id"]
        || [
            "provider",
            "model",
            "connection",
            "routing",
            "version",
            "reasoning_effort",
        ]
        .iter()
        .any(|f| execution[*f] != reviewer[*f])
    {
        return Err(Error::new(
            "FENCED",
            "Reviewer differs from its frozen comparison identity",
        ));
    }
    Ok(())
}
pub fn validate_execution(run: &Value, execution: &Value) -> Result<()> {
    validate_approval(run)?;
    if execution["comparison_approval_id"] != run["comparison"]["approval"]["id"]
        || execution["run_id"] != run["id"]
    {
        return Err(Error::new(
            "FENCED",
            "Comparison execution approval changed",
        ));
    }
    if execution["comparison_role"] == "reviewer" {
        return validate_reviewer(run, execution);
    }
    let role = execution["comparison_role"].as_str();
    let round = execution["comparison_round"].as_i64();
    if execution["role"] != "coding"
        || !(role == Some("builder") && round == Some(0)
            || role == Some("repair") && round.is_some_and(|r| (1..=2).contains(&r)))
    {
        return Err(Error::new(
            "FENCED",
            "Invalid frozen comparison execution role",
        ));
    }
    let index = execution["agent_index"]
        .as_u64()
        .and_then(|i| usize::try_from(i).ok())
        .filter(|i| *i < 2)
        .ok_or_else(|| Error::new("FENCED", "Comparison has no original builder slot"))?;
    let agent = run["comparison"]["approval"]["builders"]
        .as_array()
        .and_then(|a| a.get(index))
        .ok_or_else(|| Error::new("FENCED", "Original builder is unavailable"))?;
    if [
        "provider",
        "model",
        "routing",
        "version",
        "reasoning_effort",
    ]
    .iter()
    .any(|f| execution[*f] != agent[*f])
        || execution["connection"]
            != *agent
                .get("connection")
                .filter(|v| !v.is_null())
                .unwrap_or(&agent["provider"])
    {
        return Err(Error::new(
            "FENCED",
            "Comparison repair or builder identity changed",
        ));
    }
    Ok(())
}
#[cfg(test)]
mod tests;
