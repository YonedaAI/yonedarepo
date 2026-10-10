use crate::field;
use serde_json::{Value, json};
use yoneda_core::Result;
pub(crate) fn prompt(payload: &Value) -> Result<String> {
    if payload["team_planning"] == true {
        return crate::team_planning::prompt(payload);
    }
    let execution = &payload["execution"];
    if execution["team_task"].is_string() {
        return crate::team_prompt::prompt(payload);
    }
    if !payload["policy"]["build"].is_null() {
        let model_budget = crate::execution_limits::model_budget(&json!({"payload":payload}))?;
        let output_tokens = model_budget
            .as_ref()
            .map_or(4096, |budget| budget.max_output_tokens);
        let budget_notice = model_budget.map_or_else(String::new,|budget|format!(
            " Owner-approved shared provider/model limits: {}. Requests and spend are shared across connections, root agents, children and infrastructure retries. Check delegation_status for current usage; a child does not receive a fresh allowance.",json!(budget)));
        let task = if execution["parent_execution"].is_string() {
            format!(
                " You are a delegated child of {} at depth {}. Assigned task: {}. Keep the approved brief and criteria authoritative; your changes are an independent candidate, not an automatic merge into your parent's workspace.",
                execution["parent_execution"], execution["depth"], execution["task"]
            )
        } else {
            String::new()
        };
        let delegation = if payload["run"]["delegation"]["enabled"] == true {
            format!(
                " The owner permits bounded delegation: {}. Use delegate_agent only for useful independent work, with a stable request_id; the child inherits your provider, model, source and context. delegation_status shows your children, their evidence and current model-group allowances. Do not wait in a polling loop for children: finish your own approach while children are checked separately. Only the owner can select what ships.",
                payload["run"]["delegation"]
            )
        } else {
            " Delegation is disabled for this approved run; do not launch additional agents.".into()
        };
        return Ok(format!(
            "You are an isolated YonedaRepo coding agent. Implement the approved brief in the frozen checkout. Strategy: {}. Brief: {}. Acceptance criteria: {}. Frozen context: {}. Owner-approved build profile: {}. Read AGENTS.md and other repository instructions before editing. First call repo_context and inspect peer_status once to see declared work and dependencies. Use context_search and context_get to investigate prior alternatives and decisions. Publish a few important requirements, constraints, assumptions, findings, alternatives, proposed_decisions or questions with context_publish; give each a purpose. The platform supplies your assigned intent (intent:{}); omit intent_id rather than guessing it. Reference earlier records with supports, challenges, depends_on, supersedes, answers or motivates. Prioritize a working implementation over exhaustive context records. These are assertions; only the independent evaluator and owner can verify or approve. Change source files and run the approved checks where possible. Do not change the requested verification policy or claim publication. Each model response is capped at {} output tokens. Write and edit source in small chunks; avoid generating a large file in one tool call because truncated JSON cannot be applied. Keep changes focused and finish by calling execution_complete with a concise explanation. Your approach will be captured and evaluated independently alongside other agents. Stay within the execution deadline.{}{}{}",
            field(execution, "strategy")?,
            payload["run"]["intent"],
            payload["run"]["criteria"],
            initial_context(&payload["run"])?,
            payload["policy"]["build"],
            field(&payload["run"], "id")?,
            output_tokens,
            task,
            delegation,
            budget_notice
        ));
    }
    Ok(format!(
        "You are an isolated YonedaRepo {} agent. Strategy: {}. Intent: {}. Criteria: {}. First call repo_context, then artifact_get for EVERY shared artifact ID. The checkout is the frozen base. {} Publish a concise artifact through artifact_publish with metadata.assumptions as an ARRAY of objects, each with statement (string), metric (string), limit (integer), path (string); research MUST include at least one. For the latency assertion use metric upstream_p99_ms, limit 100, path src/main.rs. End by calling execution_complete. Do not alter the CLI contract. Use no external packages: cargo build --offline --release --bin retry-client must work. CLI contract: retry-client METHOD COMMA_SEPARATED_STATUSES LATENCY_MS BUDGET_MS MAX_ATTEMPTS emits JSON {{attempts,elapsed_ms,status}}. Retry only GET on 429 or >=500; backoff 10*2^(retry_index-1) ms; include latency and backoff in total deadline; clamp attempts to 1..10; first request always occurs. Existing source intentionally lacks retries. Research assumption to examine: upstream_p99_ms <= 100. Stay concise; finish within the configured deadline.",
        field(execution, "role")?,
        field(execution, "strategy")?,
        payload["run"]["intent"],
        payload["run"]["criteria"],
        if execution["role"] == "research" {
            "Research only: inspect source, publish concrete guidance and assumptions; do not change source."
        } else {
            "Implement the intent in the source files. Different approaches should be visible in code and explanations."
        }
    ))
}

fn initial_context(run: &Value) -> Result<Value> {
    if let Some(config) = run.get("context_study") {
        let study: yoneda_core::context_study::ContextStudy =
            serde_json::from_value(config.clone()).map_err(crate::err)?;
        study.validate()?;
        return Ok(study.initial_context());
    }
    Ok(run["context_records"].clone())
}
