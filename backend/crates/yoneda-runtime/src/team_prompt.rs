//! Team instructions preserve the frozen contract and captured dependency identities.
use crate::field;
use serde_json::{Value, json};
use yoneda_core::Result;

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
        "You are a YonedaRepo team {role}. {responsibility} Approved brief: {}. Acceptance criteria: {}. Shared interface contract: {}. Assigned task: {}. Task instructions: {}. Exclusive write scope: {}. Frozen dependency inputs: {}. Integration manifest: {}. Approved build profile: {}. Frozen prior context: {}. Shared provider/model limits: {}. Read AGENTS.md and repository instructions. First call repo_context and team_context. Read supplied handoffs and retrieve relevant prior records with context_get or context_search. Record important findings with context_publish, citing their exact record IDs with supports or depends_on; omit intent_id so the platform uses your assigned intent. Agent explanations are assertions; captured source and independent checks establish what actually changed and works. Do not edit files outside your write scope, change verification policy, delegate alternative candidates, or publish canonical source. Work in small source edits within the configured output limit and deadline. Before finishing, call task_handoff with a concise summary, the actual interface contract and exact context IDs you used in references. Then call execution_complete. Do not wait in a polling loop for other agents.",
        payload["run"]["intent"],
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
