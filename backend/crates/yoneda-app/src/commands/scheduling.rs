use crate::storage::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Result,
    agents::{MAX_ROOT_AGENTS, MIN_ROOT_AGENTS},
};

pub(super) fn validate_agents(c: &Value) -> Result<()> {
    let agents = c["agents"]
        .as_array()
        .ok_or_else(|| bad("Choose 1–6 agents"))?;
    if !(MIN_ROOT_AGENTS..=MAX_ROOT_AGENTS).contains(&agents.len()) {
        return Err(bad("Choose 1–6 agents"));
    }
    let mut strategies = BTreeSet::new();
    for agent in agents {
        let provider = string(agent, "provider")?;
        if let Some(connection) = agent.get("connection") {
            let id = connection
                .as_str()
                .ok_or_else(|| bad("Invalid provider connection"))?;
            if id.is_empty()
                || id.len() > 80
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            {
                return Err(bad("Invalid provider connection"));
            }
        }
        let model = string(agent, "model")?;
        if let Some(value) = agent.get("routing").filter(|v| !v.is_null()) {
            let route: yoneda_core::provider_routing::ProviderRouting =
                serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?;
            route.validate(&provider)?;
        }
        let strategy = string(agent, "strategy")?;
        if yoneda_core::providers::validate_model(&provider, &model).is_err()
            || model.len() > 128
            || !model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._/".contains(&b))
            || strategy.len() > 128
            || (c["mode"] != "collaborate" && !strategies.insert(strategy))
        {
            return Err(bad("Invalid provider, model or duplicate strategy"));
        }
    }
    Ok(())
}
pub(super) fn schedule<S: SqlStore>(db: &S, run: &Value, agents: &Value, now: i64) -> Result<()> {
    for (index, agent) in agents
        .as_array()
        .ok_or_else(|| bad("Missing agents"))?
        .iter()
        .enumerate()
    {
        let rid = string(run, "id")?;
        let id = format!("{rid}:agent-{}", index + 1);
        let provider = string(agent, "provider")?;
        let harness = &yoneda_core::providers::provider(&provider)?.harness;
        let mut e = json!({"id":id,"run_id":rid,"harness":harness,"provider":provider,"connection":agent.get("connection").cloned().unwrap_or_else(|| json!(provider)),"model":agent["model"],"strategy":agent["strategy"],"role":"coding","status":"queued","context":run["context"],"base":run["base"],"depth":0});
        if let Some(routing) = agent.get("routing").filter(|v| !v.is_null()) {
            e["routing"] = routing.clone();
        }
        if run.get("model_budgets").is_some() {
            e["budget"] = json!({"provider":provider,"model":agent["model"]});
        }
        create(db, "executions", &id, &e)?;
        node(
            db,
            &id,
            "execution",
            &format!("{provider}: {}", string(agent, "strategy")?),
            "platform",
            now,
            e.clone(),
        )?;
        edge(
            db,
            &rid,
            &id,
            "depends_on",
            "concurrent schedule from identical source and context",
        )?;
        for context in run["context"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            edge(db, context, &id, "provided_to", "frozen execution context")?;
        }
        job(
            db,
            &format!("job:{id}"),
            "agent",
            now,
            json!({"execution":e,"run":run,"policy":run["policy"]}),
        )?;
    }
    Ok(())
}
