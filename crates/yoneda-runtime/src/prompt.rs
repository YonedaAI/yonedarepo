use crate::field;
use serde_json::Value;
use yoneda_core::Result;
pub(crate) fn prompt(payload: &Value) -> Result<String> {
    let execution = &payload["execution"];
    if !payload["policy"]["build"].is_null() {
        return Ok(format!(
            "You are an isolated YonedaRepo coding agent. Implement the approved brief in the frozen checkout. Strategy: {}. Brief: {}. Acceptance criteria: {}. Frozen context: {}. Owner-approved build profile: {}. Read AGENTS.md and other repository instructions before editing. First call repo_context. Use context_search and context_get to investigate prior alternatives and decisions. Publish important requirements, constraints, assumptions, findings, alternatives, proposed_decisions and questions with context_publish; give each a purpose, link to intent:{} and reference earlier records with supports, challenges, depends_on, supersedes, answers or motivates. These are assertions; only the independent evaluator and owner can verify or approve. Change source files and run the approved checks where possible. Do not change the requested verification policy or claim publication. Keep changes focused and finish by calling execution_complete with a concise explanation. Your approach will be captured and evaluated independently alongside other agents. Stay within the execution deadline.",
            field(execution, "strategy")?,
            payload["run"]["intent"],
            payload["run"]["criteria"],
            payload["run"]["context_records"],
            payload["policy"]["build"],
            field(&payload["run"], "id")?
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
