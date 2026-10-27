//! Whether a frozen model budget still has requests for a team assignment.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{Error, Result, agents::MAX_RUN_MODEL_REQUESTS};

pub(super) fn available(run: &Value, agent: &Value) -> Result<bool> {
    if run["adaptive_team"]["version"] == 1
        && run["model_requests"].as_i64().unwrap_or(0)
            >= yoneda_agents_core::adaptive_team::MAX_ADAPTIVE_MODEL_REQUESTS
    {
        return Ok(false);
    }
    if run["unavailable_model_groups"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|g| g["provider"] == agent["provider"] && g["model"] == agent["model"])
    {
        return Ok(false);
    }
    if run["request_limits"] != "optional-v1"
        && run["model_requests"].as_i64().unwrap_or(0) >= MAX_RUN_MODEL_REQUESTS
    {
        return Ok(false);
    }
    let Some(_) = run.get("model_budgets") else {
        return Ok(true);
    };
    let mut execution = agent.clone();
    execution["budget"] = json!({"provider":agent["provider"],"model":agent["model"]});
    let (_, budget) = super::model_budgets::group(run, &execution)?
        .ok_or_else(|| bad("Missing approved model budget"))?;
    Ok(budget.max_requests.is_none_or(|v| budget.requests < v)
        && budget
            .spend_limit_microusd
            .is_none_or(|v| budget.charged_microusd < v))
}

pub(super) fn coordinator(run: &Value, preferred: usize) -> Result<Option<usize>> {
    let agents = run["agents"]
        .as_array()
        .ok_or_else(|| bad("Missing original roster"))?;
    for index in std::iter::once(preferred).chain(0..agents.len()) {
        if let Some(agent) = agents.get(index)
            && agent["model"] != "claude-opus-5-5"
            && available(run, agent)?
        {
            return Ok(Some(index));
        }
    }
    Ok(None)
}

pub(super) fn require_assignment(run: &Value, index: usize) -> Result<()> {
    // Keep legacy owner repair behavior when no observed operational fence exists.
    if run["unavailable_model_groups"]
        .as_array()
        .is_none_or(Vec::is_empty)
    {
        return Ok(());
    }
    let agent = run["agents"]
        .as_array()
        .and_then(|a| a.get(index))
        .ok_or_else(|| bad("Invalid approved agent index"))?;
    if !available(run, agent)? {
        return Err(Error::new(
            "MODEL_REQUEST_LIMIT",
            "Choose an available group from the original approved roster",
        ));
    }
    Ok(())
}
