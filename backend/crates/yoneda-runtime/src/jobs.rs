use crate::{err, field};
use serde_json::Value;
use std::path::PathBuf;
use yoneda_agents_core::Result;

pub(crate) async fn execute_job(
    job: &Value,
    transcript: &crate::agent_transcript::Transcript,
) -> Result<Value> {
    let root = PathBuf::from("/work/repo");
    std::fs::create_dir_all(&root).map_err(err)?;
    match field(job, "kind")? {
        "agent"
            if job["payload"]["review_only"] == true
                || job["payload"]["comparison_review"] == true
                || job["payload"]["execution"]["comparison_role"] == "reviewer" =>
        {
            crate::comparison_review::execute(job, &root, transcript).await
        }
        "agent" => crate::agent::execute(job, &root, transcript).await,
        // Refresh and publication are platform operations the Worker performs; a container
        // only captures a sealed lazy-source changeset.
        "capture" if job["payload"]["capture_subtype"] == "source_changeset" => {
            crate::source_capture::execute(job).await
        }
        "capture" => Err(err("Only sealed source changesets are captured here")),
        "evaluate" => crate::evaluation::execute(job, &root).await,
        _ => Err(err("Unknown job kind")),
    }
}
