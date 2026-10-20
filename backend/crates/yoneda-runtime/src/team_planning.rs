//! Brief-driven planning uses the frozen roster and proposes policy-validated source ownership.
use serde_json::{Value, json};
use yoneda_agents_core::Result;

pub(crate) fn prompt(payload: &Value) -> Result<String> {
    let agents = payload["run"]["agents"]
        .as_array()
        .ok_or_else(|| crate::err("Planning requires a frozen agent roster"))?;
    if agents.is_empty() {
        return Err(crate::err("Planning requires a selected agent"));
    }
    let budget = crate::execution_limits::model_budget(&json!({"payload":payload}))?;
    let hosting = if payload["policy"]["build"]["app"].is_object() {
        "The approved app host supports a JS/TS UI and API with managed SQLite, on an isolated preview origin. Preserve the approved Worker entrypoint, export and migration contracts. Owner-protected test_bundle paths are read-only: do not assign them writable task or integration scopes. The host has no outbound network or platform credentials; use only the approved local database capability. Real persisted backend behavior is required, not localStorage or a static mock."
    } else {
        "The current publisher serves static frontend output in an opaque sandbox: browser storage and external API calls are unavailable, and it does not deploy backend servers or SQLite databases. If the brief requires a backend, keep backend source/API/database tasks and deployment instructions in the plan, publish this hosting constraint with context_publish and explain the required separate deployment."
    };
    let adaptive = payload["run"]["adaptive_team"].is_object();
    let roster_rules = if adaptive {
        "The task roster may be selected only from the frozen approved pool. Preserve explicit requested connections and roles, and do not change model identities, routing, verification policy or limits."
    } else {
        "Do not add agents, change models, verification policy or limits."
    };
    let body = format!(
        "You are the YonedaRepo team planner. Inspect the current checkout and repository instructions; do not create, edit, delete or chmod source files. First call repo_context, then context_search/context_get for relevant prior records. Approved brief: {}. Owner intent clarifications: {}. Acceptance criteria: {}. Frozen source: {}. Frozen prior context: {}. Selected agents (zero-based roster indices): {}. Current verification/build profile: {}. Provider/model limits shared with subsequent tasks: {}. Create a small coherent plan specifically for this brief and existing source, not a generic event-search/RSVP template. Preserve every requested feature, language and data requirement. Self-decompose the goal and define contracts that workers can negotiate using peer_message. Workers check peer_inbox at planning, contract, edit, check and handoff checkpoints, and request coordinator repair with repair_request when blocked. Product ambiguity requires a coordinator intent_question and owner answer; preserve the frozen goal and verification policy. Choose 1–16 bounded tasks with complementary disjoint source ownership, concrete interface contracts, and necessary dependencies. Assign every selected agent to at least one task or final integration. You may assign an agent both a worker task and the later integration role; one-agent teams execute these stages in sequence. {roster_rules} Shared files such as schemas, manifests and lockfiles need one explicit owner. Integration may edit its explicit scopes, including worker files when repairs are expected. Exact files and directory prefixes ending in / are supported; absolute paths, parent traversal and .git metadata are forbidden. Discover the repository layout before selecting paths. {hosting} Do not silently replace the requested backend or signup with a static mock, localStorage, fake success, or claim a live backend. Plan output is an agent assertion validated by the platform, not proof of working behavior. Do not probe mutation tools using placeholder tasks or contracts. Submit a complete meaningful plan with team_plan_propose; correct validation errors within the configured deadline. Before completion you can refine a draft by passing its current returned ID as expected_proposal; team_context also returns the active draft. Earlier versions remain immutable and stale replays cannot select them. At most eight draft versions are allowed in this attempt. Use the exact shape {{version:1,contract:string,integrator_agent:zero_based_index,integration_paths:string[],tasks:[{{id:unique_slug,title:string,instructions:string,agent:zero_based_index,depends_on:task_slug[],write_paths:string[]}}]}}. Never use the reserved task ID integrate. Prefer few focused tasks and concise instructions to fit the output limit. After successful proposal, call execution_complete with the planned responsibilities and any hosting limitations, then stop. Do not implement the plan, wait for agents or poll. The platform activates the validated plan only after this read-only attempt finishes successfully; later captured source and independent checks establish behavior.",
        payload["run"]["intent"],
        payload["run"]["intent_clarifications"],
        payload["run"]["criteria"],
        payload["run"]["base"],
        payload["run"]["context_records"],
        json!(agents),
        payload["policy"]["build"],
        json!(budget),
    );
    if adaptive {
        Ok(format!(
            "Adaptive team planning: the one seed agent is only the read-only planner. Select the actual 1–6 agent roster from this approved connected-model pool: {}. Owner-requested roles and connections: {}. Shared pool budget configurations and current usage: {}. Prefer the lowest-cost capable approved models; use one agent unless independent work justifies more. Retain every requested row in order, its explicit connection, non-auto role and reasoning_effort. Omitted reasoning_effort is Auto and retains the existing provider default; never turn Auto into an explicit effort or increase a requested effort. An omitted planned effort inherits the owner request. Additional agent rows must leave effort omitted. Submit top-level agents:[{{connection,role}}] with team_plan_propose alongside the complete plan; task/integrator indices refer to this proposed actual roster. Roles are auto, builder, frontend, backend, design, testing or review. Include the same roster on each refined proposal. Connections bind exact frozen provider/model/routing/version; do not invent a model or connection, request credentials, or add a budget. All tasks, the planner and two repair rounds share the 144-request run cap and existing spend authority; separate model caps do not expand the workspace allowance. The platform validates and activates the roster only on successful unchanged-source planner completion.\n\n{body}",
            payload["run"]["approved_model_pool"],
            payload["run"]["adaptive_team"]["requested_agents"],
            payload["run"]["model_budgets"]
        ))
    } else {
        Ok(body)
    }
}

#[cfg(test)]
#[path = "tests/team_planning.rs"]
mod tests;

#[cfg(test)]
#[path = "tests/adaptive_planning.rs"]
mod adaptive_tests;
