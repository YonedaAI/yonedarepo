//! Brief-driven planning uses the frozen roster and proposes policy-validated source ownership.
use serde_json::{Value, json};
use yoneda_core::Result;

pub(crate) fn prompt(payload: &Value) -> Result<String> {
    let agents = payload["run"]["agents"]
        .as_array()
        .ok_or_else(|| crate::err("Planning requires a frozen agent roster"))?;
    if agents.is_empty() {
        return Err(crate::err("Planning requires a selected agent"));
    }
    let budget = crate::execution_limits::model_budget(&json!({"payload":payload}))?;
    Ok(format!(
        "You are the YonedaRepo team planner. Inspect the current checkout and repository instructions; do not create, edit, delete or chmod source files. First call repo_context, then context_search/context_get for relevant prior records. Approved brief: {}. Acceptance criteria: {}. Frozen source: {}. Frozen prior context: {}. Selected agents (zero-based roster indices): {}. Current verification/build profile: {}. Provider/model limits shared with subsequent tasks: {}. Create a small coherent plan specifically for this brief and existing source, not a generic event-search/RSVP template. Preserve every requested feature, language and data requirement. Choose 1–16 bounded tasks with complementary disjoint source ownership, concrete interface contracts, and necessary dependencies. Assign every selected agent to at least one task or final integration. You may assign an agent both a worker task and the later integration role; one-agent teams execute these stages in sequence. Do not add agents, change models, verification policy or limits. Shared files such as schemas, manifests and lockfiles need one explicit owner. Integration may edit its explicit scopes, including worker files when repairs are expected. Exact files and directory prefixes ending in / are supported; absolute paths, parent traversal and .git metadata are forbidden. Discover the repository layout before selecting paths. The current publisher serves static frontend output in an opaque sandbox: browser storage and external API calls are unavailable, and it does not deploy backend servers or SQLite databases. If the brief requires a backend, keep backend source/API/database tasks and deployment instructions in the plan, publish this hosting constraint with context_publish and explain the required separate deployment. Do not silently replace the requested backend or signup with a static mock, localStorage, fake success, or claim a live backend. Plan output is an agent assertion validated by the platform, not proof of working behavior. Do not probe mutation tools using placeholder tasks or contracts. Submit a complete meaningful plan with team_plan_propose; correct validation errors within the configured deadline. Before completion you can refine a draft by passing its current returned ID as expected_proposal; team_context also returns the active draft. Earlier versions remain immutable and stale replays cannot select them. At most eight draft versions are allowed in this attempt. Use the exact shape {{version:1,contract:string,integrator_agent:zero_based_index,integration_paths:string[],tasks:[{{id:unique_slug,title:string,instructions:string,agent:zero_based_index,depends_on:task_slug[],write_paths:string[]}}]}}. Never use the reserved task ID integrate. Prefer few focused tasks and concise instructions to fit the output limit. After successful proposal, call execution_complete with the planned responsibilities and any hosting limitations, then stop. Do not implement the plan, wait for agents or poll. The platform activates the validated plan only after this read-only attempt finishes successfully; later captured source and independent checks establish behavior.",
        payload["run"]["intent"],
        payload["run"]["criteria"],
        payload["run"]["base"],
        payload["run"]["context_records"],
        json!(agents),
        payload["policy"]["build"],
        json!(budget),
    ))
}

#[cfg(test)]
#[path = "tests/team_planning.rs"]
mod tests;
