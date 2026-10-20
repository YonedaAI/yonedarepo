//! Validate the complete amended DAG before fencing or modifying any task.
use super::*;
use yoneda_agents_core::team::TeamTask;

pub(super) fn apply<S: SqlStore>(
    db: &S,
    c: &Value,
    run: &Value,
    selected: &BTreeSet<String>,
    agent: bool,
) -> Result<(TeamPlan, BTreeSet<String>)> {
    let mut next = plan(run)?;
    let mut added = BTreeSet::new();
    if agent
        && selected.contains("integrate")
        && run["unavailable_model_groups"]
            .as_array()
            .is_some_and(|g| !g.is_empty())
        && super::super::super::budget_availability::require_assignment(run, next.integrator_agent)
            .is_err()
    {
        let job = get(db, "jobs", &string(c, "job_id")?)?;
        let execution = &job["payload"]["execution"];
        if execution["team_role"] == "coordinator" {
            let agents = run["agents"]
                .as_array()
                .ok_or_else(|| bad("Missing approved roster"))?;
            let index = agents
                .iter()
                .position(|a| {
                    a["provider"] == execution["provider"]
                        && a["model"] == execution["model"]
                        && a.get("connection").unwrap_or(&a["provider"])
                            == execution
                                .get("connection")
                                .unwrap_or(&execution["provider"])
                })
                .ok_or_else(|| {
                    Error::new("FORBIDDEN", "Coordinator is outside the original roster")
                })?;
            super::super::super::budget_availability::require_assignment(run, index)?;
            next.integrator_agent = index;
        }
    }
    if let Some(definitions) = c.get("task_definitions") {
        let definitions: Vec<TeamTask> =
            serde_json::from_value(definitions.clone()).map_err(|e| bad(&e.to_string()))?;
        if definitions.is_empty() || definitions.len() > yoneda_agents_core::team::MAX_TEAM_TASKS {
            return Err(bad("Choose 1–16 task definitions"));
        }
        let mut ids = BTreeSet::new();
        for definition in definitions {
            if !selected.contains(&definition.id) || !ids.insert(definition.id.clone()) {
                return Err(bad(
                    "Every unique amended definition must be selected for repair",
                ));
            }
            if agent {
                super::super::super::autonomy::validate_scopes(run, &definition.write_paths)?;
            }
            if let Some(current) = next.tasks.iter_mut().find(|t| t.id == definition.id) {
                *current = definition;
            } else {
                added.insert(definition.id.clone());
                next.tasks.push(definition);
            }
        }
    }
    next.validate(run["agents"].as_array().map_or(0, Vec::len))?;
    if agent {
        let executions = run_executions(db, &string(run, "id")?)?;
        let unscheduled =
            next.tasks
                .iter()
                .filter(|t| {
                    !executions
                        .iter()
                        .any(|e| e["id"] == task_id(run["id"].as_str().unwrap_or_default(), &t.id))
                })
                .count()
                + usize::from(!executions.iter().any(|e| {
                    e["id"] == task_id(run["id"].as_str().unwrap_or_default(), "integrate")
                }));
        let limit = run["autonomy_policy"]["max_executions"]
            .as_u64()
            .unwrap_or(20);
        if executions.len().saturating_add(unscheduled)
            > usize::try_from(limit).map_err(|_| bad("Invalid execution limit"))?
        {
            return Err(Error::new(
                "RESOURCE_LIMIT",
                "No approved execution slots remain for amended tasks",
            ));
        }
    }
    Ok((next, added))
}
