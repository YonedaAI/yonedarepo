//! Team instructions preserve the frozen contract and captured dependency identities.
use crate::field;
use serde_json::{Value, json};
use yoneda_core::Result;

// Codex 0.161 offers local MCP tools through deferred functions.exec discovery.
pub(crate) const CODEX_READ_ONLY_TOOLS: &str = r#"Codex read-only platform checkpoint: before workspace analysis or local commands, discover the YonedaRepo MCP tools through functions.exec and ALL_TOOLS. An empty top-level tool catalog does not mean the MCP tools are unavailable. In functions.exec, run:
text(ALL_TOOLS.filter(t => /^mcp__yonedarepo__(repo_context|team_context|peer_status|peer_inbox|team_plan_propose|repair_team|intent_question|execution_complete)$/.test(t.name)));
Then invoke the actual platform tools in functions.exec:
text(await tools.mcp__yonedarepo__repo_context({}));
text(await tools.mcp__yonedarepo__team_context({}));
text(await tools.mcp__yonedarepo__peer_status({}));
text(await tools.mcp__yonedarepo__peer_inbox({}));
Read the returned context and exact guards before inspecting source or deciding recovery. Discover any other needed YonedaRepo tool in ALL_TOOLS by its exact name and call it through tools.mcp__yonedarepo__<name>. Use team_plan_propose for the initial planner's proposal, or repair_team for the coordinator's bounded repair, and inspect the returned platform receipts. Local commands and a final prose plan cannot substitute for those tool calls or receipts. Keep the frozen goal, approved roster, policy and shared budgets authoritative. Do not commit or push from this read-only role. If discovery or a tool call fails, report the exact observed error; do not claim tools are unavailable without trying discovery, manufacture a repair receipt, or claim an intent question was delivered without its successful platform result."#;

pub(crate) fn prompt(payload: &Value) -> Result<String> {
    let execution = &payload["execution"];
    let budget = crate::execution_limits::model_budget(&json!({"payload":payload}))?;
    let role = field(execution, "team_role")?;
    let responsibility = match role {
        "worker" => {
            "Implement only your assigned task. Other specialists own the other tasks; do not rebuild their work. Dependencies are already assembled from immutable captured source. Preserve their files. Your output is a handoff, not a selectable shipping candidate."
        }
        "integrator" => {
            "Every specialist's immutable captured output is already assembled in this checkout. Call integration_request to inspect the exact manifest, then connect those outputs into one complete implementation. Preserve the specialist outputs; repair only files explicitly included in your write scope. Explain any repair in your handoff. This integrated revision alone will receive independent checks and the owner's shipping decision."
        }
        _ => return Err(crate::err("Unknown frozen team role")),
    };
    Ok(format!(
        "You are a YonedaRepo team {role}. {responsibility} Approved brief: {}. Owner intent clarifications: {}. Acceptance criteria: {}. Shared interface contract: {}. Assigned task: {}. Task instructions: {}. Exclusive write scope: {}. Frozen dependency inputs: {}. Integration manifest: {}. Approved build profile: {}. Frozen prior context: {}. Shared provider/model limits: {}. Read AGENTS.md and repository instructions. First call repo_context, team_context and peer_inbox. Self-decompose your task into small source and verification steps. Negotiate actual interface contracts with peer_message to the coordinator or the affected task, citing exact context IDs. Check peer_inbox at contract decisions, before editing dependent files, after checks and before handoff; acknowledge received message IDs and use the returned cursor. Messages are assertions, not source authority. If a dependency, scope or integration check blocks progress, send a blocker and call repair_request with a stable request_id and reason. The coordinator may amend the DAG within the approved project scopes, frozen goal, policy and shared model budgets, for at most two total repair rounds. If product intent is ambiguous, request an intent_question through the coordinator, then finish the current checkpoint without guessing. Repaired integration needs fresh trusted capture and independent checks. Never auto-publish canonical source. Read supplied handoffs and retrieve relevant prior records with context_get or context_search. Record important findings with context_publish, citing their exact record IDs with supports or depends_on; omit intent_id so the platform uses your assigned intent. Agent explanations are assertions; captured source and independent checks establish what actually changed and works. Do not edit files outside your write scope, change verification policy, delegate alternative candidates, or publish canonical source. Work in small source edits within the configured output limit and deadline. Before finishing, call task_handoff with a summary that opens with one plain sentence telling a non-technical reviewer what you built or changed (no IDs, commits or file paths), then the concise technical detail, the actual interface contract and exact context IDs you used in references. Then call execution_complete. Do not wait in a polling loop for other agents.",
        payload["run"]["intent"],
        payload["run"]["intent_clarifications"],
        payload["run"]["criteria"],
        payload["run"]["team_plan"]["contract"],
        execution["strategy"],
        execution["task"],
        payload["team_owned_paths"],
        payload["team_inputs"],
        payload["integration_manifest"],
        payload["policy"]["build"],
        payload["run"]["context_records"],
        json!(budget),
    ))
}

pub(crate) fn coordinator_prompt(payload: &Value) -> Result<String> {
    let budget = crate::execution_limits::model_budget(&json!({"payload":payload}))?;
    Ok(format!(
        "You are the read-only YonedaRepo recovery coordinator. Read AGENTS.md and inspect the checkout without editing, deleting or chmodding source. Approved goal: {}. Acceptance criteria: {}. Owner intent clarifications: {}. Frozen context: {}. Frozen autonomy approval: {}. Shared model budgets: {}. First call repo_context, team_context, peer_status and peer_inbox. Inspect exact task revisions, DAG dependencies, captured handoffs, candidate check failures and conflict records. Self-decompose the recovery and negotiate interfaces with peer_message, checking and acknowledging peer_inbox at contract decisions and before requesting repairs or finishing. Preserve unchanged task outputs. Call repair_team with a stable request_id, exact run/head/version/plan guards and every affected task revision, including all descendants and integrate. Optional task_definitions upsert selected tasks within the approved source scopes, frozen roster and execution cap; shared files need one owner and scopes must be disjoint. Do not change the approved goal, verification policy, models or budget. For a working branch race, refresh_candidate onto the current checked target; inspect the trusted result. Clean refreshes require fresh checks. For an unresolved three-way merge, call resolve_conflict with its exact target, plan and affected task versions; its resolver derives intent and context from this run. DAG repair and autonomous conflict resolution share two total rounds and the existing model allowances. If product intent requires an owner decision, call intent_question with a stable request_id and a bounded question/options; then call execution_complete and stop. Never invent an answer while awaiting intent. Explain exhausted or unsupported recovery with a blocker and evidence, then finish. Do not wait in polling loops. Repair receipts are not successful source/check evidence. Every clean or repaired integrated revision must receive fresh trusted capture and independent checks. Only the owner may publish canonical source. Call execution_complete with the concrete recovery decision and references.",
        payload["run"]["intent"],
        payload["run"]["criteria"],
        payload["run"]["intent_clarifications"],
        payload["run"]["context_records"],
        payload["run"]["autonomy_policy"],
        json!(budget)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn specialists_and_integrators_receive_complementary_instructions_and_exact_inputs() {
        let mut payload = json!({"execution":{"team_role":"worker","strategy":"Search specialist","task":"Implement search"},"run":{"intent":"Build events","criteria":["Search works"],"team_plan":{"contract":"searchEvents(events, query)"},"context_records":[{"id":"context:prior","statement":"Preserve anonymous visits"}]},"team_owned_paths":["public/search.mjs"],"team_inputs":[{"task_id":"data","revision":{"commit":"exact-commit"},"handoff_id":"handoff:captured"}],"policy":{"build":{}}});
        let worker = prompt(&payload).unwrap();
        assert!(worker.contains("Implement only your assigned task"));
        assert!(worker.contains("public/search.mjs"));
        assert!(worker.contains("exact-commit"));
        assert!(worker.contains("handoff:captured"));
        assert!(worker.contains("context:prior"));
        assert!(!worker.contains("independently alongside"));
        payload["execution"]["team_role"] = json!("integrator");
        let integrated = prompt(&payload).unwrap();
        assert!(integrated.contains("Call integration_request"));
        assert!(integrated.contains("integrated revision alone"));
        payload["execution"]["team_role"] = json!("invented");
        assert!(prompt(&payload).is_err());
    }
}
