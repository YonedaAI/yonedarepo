use crate::{agent_transcript::Transcript, field};
use serde_json::Value;
use std::path::Path;
use yoneda_agents_core::Result;
pub(crate) async fn execute(job: &Value, root: &Path, transcript: &Transcript) -> Result<Value> {
    validate_reasoning_job(job)?;
    let approved_budget = crate::execution_limits::model_budget(job)?;
    if !crate::source_workspace_job::enabled(job) {
        return Err(crate::err("Agents work only in a lazy source workspace"));
    }
    crate::source_workspace_agent::execute(
        job,
        root,
        transcript,
        &agent_prompt(job)?,
        approved_budget.as_ref(),
    )
    .await
}

fn validate_reasoning_job(job: &Value) -> Result<()> {
    let execution = &job["payload"]["execution"];
    let effort =
        yoneda_agents_core::adaptive_team::execution_effort(&job["payload"]["run"], execution)?;
    if effort.is_some()
        && (job["model"] != execution["model"]
            || execution["harness"]
                != yoneda_agents_core::providers::provider(field(execution, "provider")?)?.harness)
    {
        return Err(yoneda_agents_core::Error::new(
            "FENCED",
            "Reasoning effort model or harness changed",
        ));
    }
    Ok(())
}

fn agent_prompt(job: &Value) -> Result<String> {
    if job["payload"]["review_only"] == true || job["payload"]["comparison_review"] == true {
        return crate::comparison_review::prompt(job);
    }
    let payload = &job["payload"];
    let execution = &payload["execution"];
    let read_only = payload["team_planning"] == true
        || execution["team_role"] == "planner"
        || execution["team_role"] == "coordinator";
    let mut body = crate::prompt::prompt(payload)?;
    if let Some(repair) = payload.get("comparison_repair") {
        body = format!(
            "Repair ONLY captured candidate {} at exact source {}. Approved repair instructions: {}. Frozen allowed write paths: {}. Preserve the original brief and criteria; capture and independent checking happen after your completed source. Never change verification policy, widen your scope, or claim publication.\n\n{body}",
            repair["candidate_id"],
            repair["source_revision"],
            repair["instructions"],
            repair["write_paths"]
        );
    }
    let mut prompt = if read_only && execution["harness"] == "codex" {
        format!("{}\n\n{body}", crate::team_prompt::CODEX_READ_ONLY_TOOLS)
    } else {
        body
    };
    if crate::source_workspace_job::enabled(job) {
        prompt.push_str("\n\nWorkspace transport: api-source-v1. Normal file operations and scoped source_* MCP tools use one staged SourceWorkspace authority. Inspect files on demand. Do not clone, Git commit, push or publish; the supervisor seals changes and a separate capture/evaluator checks exact Git source. Generated dependencies/build output are local scratch only. Staged writes are not checked or published evidence.\n");
    }
    Ok(prompt)
}

#[cfg(test)]
use crate::{
    agent_harness::{
        claude_arguments, codex_configuration, configure_output_limit, gemini_settings,
    },
    process::untrusted,
};
#[cfg(test)]
#[path = "tests/agent_config.rs"]
mod tests;
