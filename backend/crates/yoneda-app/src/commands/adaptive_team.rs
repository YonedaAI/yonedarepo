//! Approved pool/request authority stays immutable while one planner attests an actual roster.
use crate::storage::*;
use serde_json::{Value, json};
use yoneda_agents_core::{
    Error, Result,
    adaptive_team::{AdaptiveTeam, AgentSelection, ApprovedModel},
};
mod effort;
mod specialists;
pub(super) use effort::configure_execution;

pub(super) fn freeze(c: &Value, run: &mut Value) -> Result<()> {
    let Some(request) = c.get("adaptive_team") else {
        return Ok(());
    };
    if c.get("job_id").is_some()
        || c.get("_grant").is_some()
        || run["mode"] != "collaborate"
        || run["team_planning"] != "automatic"
        || c.get("campaign").is_some()
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Adaptive teams require a normal owner-approved automatic collaborative run",
        ));
    }
    let request: AdaptiveTeam =
        serde_json::from_value(request.clone()).map_err(|e| bad(&e.to_string()))?;
    let pool: Vec<ApprovedModel> = serde_json::from_value(c["_approved_model_pool"].clone())
        .map_err(|_| Error::new("FORBIDDEN", "Trusted connected-model pool required"))?;
    request.validate(&pool)?;
    let agents = run["agents"]
        .as_array()
        .ok_or_else(|| bad("Adaptive run needs one seed"))?;
    if agents.len() != 1 {
        return Err(bad(
            "Adaptive planning begins with exactly one approved seed agent",
        ));
    }
    validate_member(&pool, &agents[0])?;
    let seed = AgentSelection {
        connection: string(&agents[0], "connection")?,
        role: serde_json::from_value(agents[0]["role_hint"].clone())
            .map_err(|_| bad("Seed role hint required"))?,
        reasoning_effort: serde_json::from_value(agents[0]["reasoning_effort"].clone())
            .map_err(|_| bad("Invalid seed reasoning effort"))?,
    };
    let first = &request.requested_agents[0];
    effort::validate_auto_seed(first, &agents[0])?;
    if first
        .connection
        .as_ref()
        .is_some_and(|c| c != &seed.connection)
        || first.role != seed.role
        || first.reasoning_effort != seed.reasoning_effort
    {
        return Err(Error::new(
            "FORBIDDEN",
            "Initial seed differs from the requested connection or role",
        ));
    }
    if seed.reasoning_effort.is_some_and(|e| {
        !pool
            .iter()
            .any(|m| m.connection == seed.connection && m.reasoning_efforts.contains(&e))
    }) {
        return Err(Error::new(
            "FORBIDDEN",
            "Seed reasoning effort is unsupported",
        ));
    }
    run["approved_model_pool"] = json!(pool);
    run["adaptive_team"] = json!(request);
    run["adaptive_seed_agents"] = run["agents"].clone();
    run["adaptive_team_digest"] = json!(digest(run)?);
    Ok(())
}
fn digest(run: &Value) -> Result<String> {
    yoneda_agents_core::fingerprint(
        &json!({"pool":run["approved_model_pool"],"request":run["adaptive_team"]}),
    )
}
fn parsed(run: &Value) -> Result<(AdaptiveTeam, Vec<ApprovedModel>)> {
    let request: AdaptiveTeam =
        serde_json::from_value(run["adaptive_team"].clone()).map_err(|e| bad(&e.to_string()))?;
    let pool: Vec<ApprovedModel> = serde_json::from_value(run["approved_model_pool"].clone())
        .map_err(|e| bad(&e.to_string()))?;
    request.validate(&pool)?;
    if run["adaptive_team_digest"] != digest(run)? {
        return Err(Error::new(
            "FENCED",
            "Approved adaptive pool or requests changed",
        ));
    }
    Ok((request, pool))
}
fn validate_member(pool: &[ApprovedModel], agent: &Value) -> Result<()> {
    let member = pool
        .iter()
        .find(|m| agent["connection"] == m.connection)
        .ok_or_else(|| Error::new("FORBIDDEN", "Agent is outside the frozen model pool"))?;
    if agent["provider"] != member.provider
        || agent["model"] != member.model
        || agent["routing"] != json!(member.routing)
        || agent["version"] != json!(member.version)
    {
        return Err(Error::new(
            "FENCED",
            "Agent connection, model, routing or version differs from the approved pool",
        ));
    }
    Ok(())
}
/// Builds the planned roster; may normalize `plan.integrator_agent` for the approved model mix.
pub(super) fn select(
    run: &Value,
    value: Option<&Value>,
    plan: &mut yoneda_agents_core::team::TeamPlan,
) -> Result<Option<Value>> {
    if run["adaptive_team"].is_null() {
        if value.is_some() {
            return Err(Error::new(
                "FORBIDDEN",
                "Legacy planner cannot replace the frozen roster",
            ));
        }
        return Ok(None);
    }
    validate_approval(run)?;
    let (request, pool) = parsed(run)?;
    let mut selections: Vec<AgentSelection> = if let Some(value) = value {
        serde_json::from_value(value.clone()).map_err(|e| bad(&e.to_string()))?
    } else {
        request
            .requested_agents
            .iter()
            .map(|r| AgentSelection {
                connection: r.connection.clone().unwrap_or_else(|| {
                    run["adaptive_seed_agents"][0]["connection"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                }),
                role: r.role,
                reasoning_effort: r.reasoning_effort,
            })
            .collect()
    };
    for (index, selection) in selections.iter_mut().enumerate() {
        if selection.reasoning_effort.is_none() {
            selection.reasoning_effort = request
                .requested_agents
                .get(index)
                .and_then(|r| r.reasoning_effort);
        }
    }
    specialists::assign(run, &request, &pool, &mut selections, plan)?;
    request.validate_selection(&pool, &selections)?;
    let agents = selections
        .into_iter()
        .map(|selection| {
            let member = pool
                .iter()
                .find(|m| m.connection == selection.connection)
                .ok_or_else(|| bad("Missing approved connection"))?;
            let mut agent = json!(member);
            agent["role_hint"] = json!(selection.role);
            if let Some(effort) = selection.reasoning_effort {
                agent["reasoning_effort"] = json!(effort);
            }
            agent["strategy"] = json!(format!(
                "{} team participant",
                json!(selection.role).as_str().unwrap_or("auto")
            ));
            Ok(agent)
        })
        .collect::<Result<Vec<Value>>>()?;
    Ok(Some(json!(agents)))
}
pub(super) fn validate_roster(run: &Value, agents: &Value) -> Result<()> {
    let (request, pool) = parsed(run)?;
    let agents = agents
        .as_array()
        .ok_or_else(|| bad("Missing actual roster"))?;
    let selections = agents
        .iter()
        .map(|a| {
            validate_member(&pool, a)?;
            Ok(AgentSelection {
                connection: string(a, "connection")?,
                role: serde_json::from_value(a["role_hint"].clone())
                    .map_err(|_| bad("Invalid planned role"))?,
                reasoning_effort: serde_json::from_value(a["reasoning_effort"].clone())
                    .map_err(|_| bad("Invalid planned reasoning effort"))?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    request.validate_selection(&pool, &selections)
}
pub(super) fn activate(run: &mut Value, agents: &Value) -> Result<()> {
    validate_roster(run, agents)?;
    run["agents"] = agents.clone();
    run["planned_roster_digest"] = json!(yoneda_agents_core::fingerprint(agents)?);
    Ok(())
}
pub(super) fn validate_approval(run: &Value) -> Result<()> {
    if run["adaptive_team"].is_null() {
        if run["agents"] != run["autonomy_approval"]["agents"] {
            return Err(Error::new("FENCED", "Original agent roster changed"));
        }
        return Ok(());
    }
    let (_, pool) = parsed(run)?;
    if budget_configuration(&run["model_budgets"])?
        != budget_configuration(&run["autonomy_approval"]["model_budgets"])?
    {
        return Err(Error::new(
            "FENCED",
            "Adaptive approved model budget configuration changed",
        ));
    }
    for field in [
        "approved_model_pool",
        "adaptive_team",
        "adaptive_team_digest",
    ] {
        if run[field] != run["autonomy_approval"][field] {
            return Err(Error::new("FENCED", "Adaptive owner approval changed"));
        }
    }
    if let Some(digest) = run.get("planned_roster_digest") {
        validate_roster(run, &run["agents"])?;
        if *digest != json!(yoneda_agents_core::fingerprint(&run["agents"])?) {
            return Err(Error::new(
                "FENCED",
                "Platform-attested planned roster changed",
            ));
        }
    } else {
        if run["agents"] != run["adaptive_seed_agents"]
            || run["agents"].as_array().map_or(0, Vec::len) != 1
        {
            return Err(Error::new("FENCED", "Initial seed roster changed"));
        }
        validate_member(&pool, &run["agents"][0])?;
        if run["agents"][0]["reasoning_effort"]
            != run["adaptive_team"]["requested_agents"][0]["reasoning_effort"]
        {
            return Err(Error::new(
                "FENCED",
                "Initial seed reasoning effort changed",
            ));
        }
    }
    Ok(())
}

fn budget_configuration(value: &Value) -> Result<Value> {
    let mut budgets = value
        .as_array()
        .cloned()
        .ok_or_else(|| bad("Missing approved model budgets"))?;
    for budget in &mut budgets {
        let object = budget
            .as_object_mut()
            .ok_or_else(|| bad("Invalid approved budget"))?;
        object.remove("requests");
        object.remove("charged_microusd");
    }
    Ok(json!(budgets))
}
