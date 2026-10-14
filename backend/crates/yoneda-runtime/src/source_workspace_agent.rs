//! API source agent completion carries compact sealed metadata, never a Git clone or source export.
use crate::{agent_transcript::Transcript, source_workspace_run::SourceRun};
use serde_json::{Value, json};
use std::path::Path;
use yoneda_core::{Result, model_budget::ModelBudget};
pub(crate) async fn execute(
    job: &Value,
    root: &Path,
    transcript: &Transcript,
    prompt: &str,
    budget: Option<&ModelBudget>,
) -> Result<Value> {
    let parent = root
        .parent()
        .ok_or_else(|| crate::err("Source workspace parent missing"))?;
    let session = SourceRun::prepare(job, parent, false)?;
    let evidence =
        crate::agent_harness::run(job, session.root(), transcript, prompt, budget).await?;
    let workspace = session.finish(&format!("source-complete-{}", crate::field(job, "id")?))?;
    let mut result =
        json!({"source_workspace":workspace,"transcript":evidence["digest"],"model":job["model"]});
    if job["payload"]["team_planning"] == true
        || ["planner", "coordinator"]
            .iter()
            .any(|role| job["payload"]["execution"]["team_role"] == *role)
    {
        result["planning"] = json!(true);
        result["source_unchanged"] = json!(true);
    }
    Ok(result)
}
