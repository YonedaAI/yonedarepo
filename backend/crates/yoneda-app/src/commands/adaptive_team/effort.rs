use super::*;

pub(super) fn validate_auto_seed(
    request: &yoneda_agents_core::adaptive_team::RequestedAgent,
    agent: &Value,
) -> Result<()> {
    if request.connection.is_none()
        && !yoneda_agents_core::providers::provider(&string(agent, "provider")?)?
            .models
            .iter()
            .any(|m| agent["model"] == m.id && m.auto_seed_eligible)
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Auto seed requires an already compatible approved model",
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "../team/tests/fixed_reasoning.rs"]
mod tests;

pub(in crate::commands) fn configure_execution(
    run: &Value,
    agent: &Value,
    index: usize,
    execution: &mut Value,
) -> Result<()> {
    let adaptive = run["adaptive_team"].is_object();
    let explicit = run["agents"]
        .as_array()
        .is_some_and(|agents| agents.iter().any(|a| !a["reasoning_effort"].is_null()));
    if !adaptive && !explicit {
        return Ok(());
    }
    if adaptive || run["autonomy_approval"]["agents"].is_array() {
        validate_approval(run)?;
    }
    execution["agent_index"] = json!(index);
    if let Some(value) = agent.get("reasoning_effort").filter(|v| !v.is_null()) {
        execution["reasoning_effort"] = value.clone();
    }
    yoneda_agents_core::adaptive_team::execution_effort(run, execution)?;
    Ok(())
}
