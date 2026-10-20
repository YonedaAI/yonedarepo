//! Deterministic owner-approved model mix: slots owning specialist tasks use the approved
//! specialist connection; planning, integration and coordination keep their planned model.
//! Adaptive budgets already cover every pool member (`model_budgets::freeze`), so the
//! specialist always has its own approved cap.
use super::*;
use std::collections::BTreeSet;
use yoneda_agents_core::{
    adaptive_team::{AgentRole, MAX_ADAPTIVE_AGENTS},
    team::TeamPlan,
};

fn member<'a>(request: &AdaptiveTeam, pool: &'a [ApprovedModel]) -> Option<&'a ApprovedModel> {
    let connection = request.specialist_connection.as_ref()?;
    pool.iter().find(|m| &m.connection == connection)
}

/// Moves task-owning slots to the specialist connection when its group is still available.
/// An integrator sharing a moved slot gets its own slot on the original connection; when the
/// roster is full that slot is left unchanged. Unavailable groups never trigger a fallback.
pub(super) fn assign(
    run: &Value,
    request: &AdaptiveTeam,
    pool: &[ApprovedModel],
    selections: &mut Vec<AgentSelection>,
    plan: &mut TeamPlan,
) -> Result<()> {
    let Some(member) = member(request, pool) else {
        return Ok(());
    };
    if !super::super::budget_availability::available(run, &json!(member))? {
        return Ok(());
    }
    let owners: BTreeSet<usize> = plan.tasks.iter().map(|task| task.agent).collect();
    let integrator = plan.integrator_agent;
    let can_split = selections.len() < MAX_ADAPTIVE_AGENTS;
    let mut integrator_connection = None;
    for (index, selection) in selections.iter_mut().enumerate() {
        let movable = owners.contains(&index)
            && selection.connection != member.connection
            && request
                .requested_agents
                .get(index)
                .is_none_or(|r| r.connection.is_none())
            && selection
                .reasoning_effort
                .is_none_or(|effort| member.reasoning_efforts.contains(&effort));
        if !movable || index == integrator && !can_split {
            continue;
        }
        if index == integrator {
            integrator_connection = Some(selection.connection.clone());
        }
        selection.connection = member.connection.clone();
    }
    if let Some(connection) = integrator_connection {
        selections.push(AgentSelection {
            connection,
            role: AgentRole::Auto,
            reasoning_effort: None,
        });
        plan.integrator_agent = selections.len() - 1;
    }
    Ok(())
}
