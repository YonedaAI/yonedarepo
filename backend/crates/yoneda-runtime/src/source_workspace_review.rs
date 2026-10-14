//! Lazy captured comparison views. No coding fork, eager materialization, export or capture.
use crate::{agent_transcript::Transcript, broker::broker, source_workspace_run::SourceRun};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};
use yoneda_core::{Result, model_budget::ModelBudget};
pub(crate) async fn execute(
    job: &Value,
    root: &Path,
    transcript: &Transcript,
    budget: &ModelBudget,
) -> Result<Value> {
    let specs = crate::source_workspace_job::mounts(job)?;
    let frozen = &job["payload"]["comparison_manifest"];
    let alternatives = frozen["manifest"]["alternatives"]
        .as_array()
        .ok_or_else(|| crate::err("Frozen comparison alternatives missing"))?;
    let captured: Vec<_> = alternatives
        .iter()
        .filter(|entry| entry["candidate_id"].is_string())
        .collect();
    if captured.len() != specs.len() {
        return Err(crate::err("Comparison source set changed"));
    }
    let mut mapping = Vec::new();
    for (index, alternative) in captured.iter().enumerate() {
        let alias = format!("candidate-{index}");
        let spec = specs
            .iter()
            .find(|spec| spec.path == alias)
            .ok_or_else(|| crate::err("Frozen comparison source missing"))?;
        if alternative["revision"]["repository"] != spec.base.repository
            || alternative["revision"]["commit"] != spec.base.commit
        {
            return Err(crate::err("Comparison captured source changed"));
        }
        mapping.push(json!({"candidate_id":alternative["candidate_id"],"directory":alias}));
    }
    let session = SourceRun::prepare(job, root, false)?;
    use std::io::Write;
    let mut index = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o444)
        .open(root.join("comparison-sources.json"))
        .map_err(crate::err)?;
    index
        .write_all(
            serde_json::to_string(&mapping)
                .map_err(crate::err)?
                .as_bytes(),
        )
        .map_err(crate::err)?;
    drop(index);
    // Physical parent metadata is root-owned; source mounts separately enforce native read_only.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        let root = std::ffi::CString::new(root.as_os_str().as_bytes()).map_err(crate::err)?;
        if unsafe { libc::chown(root.as_ptr(), 0, 0) } != 0 {
            return Err(crate::err("Review metadata root ownership failed"));
        }
    }
    fs::set_permissions(root, fs::Permissions::from_mode(0o555)).map_err(crate::err)?;
    let evidence = crate::agent_harness::run(
        job,
        session.root(),
        transcript,
        &crate::comparison_review::prompt(job)?,
        Some(budget),
    )
    .await?;
    let workspace = session.finish(&format!("source-review-{}", crate::field(job, "id")?))?;
    let receipt = broker("/comparison-result", json!({}), true).await?;
    if receipt["manifest_digest"] != frozen["manifest_digest"] || !receipt["review_id"].is_string()
    {
        return Err(crate::err(
            "No submitted comparison receipt matches this attempt",
        ));
    }
    Ok(
        json!({"review_only":true,"source_unchanged":true,"source_workspace":workspace,"review_id":receipt["review_id"],"manifest_digest":frozen["manifest_digest"],"transcript":evidence["digest"],"model":job["model"]}),
    )
}
