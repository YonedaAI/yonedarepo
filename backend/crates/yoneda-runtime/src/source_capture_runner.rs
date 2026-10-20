//! Complete incremental trusted capture. The tree is built here from the sealed delta; the
//! platform commits the same changes and its readback is the result authority.
use crate::{
    source_capture_api::{CaptureApi, failure},
    source_capture_diff::touched_diff,
    source_capture_files::{CaptureFiles, prepare},
    source_capture_manifest::assemble_manifest,
    source_capture_trees::TreeCache,
    source_git::SourceGitObjects,
    source_git_rewrite::{TreeEdit, rewrite_tree},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_agents_core::{Result, source_workspace::MAX_UPLOAD_BYTES};

pub(crate) async fn execute(job: &Value) -> Result<Value> {
    if job["kind"] != "capture" || job["payload"]["capture_subtype"] != "source_changeset" {
        return Err(failure(
            "Capture job is not approved for API-source transport",
        ));
    }
    execute_with(job, &CaptureApi::from_root()?).await
}

/// The platform commit request: every touched path with its final bytes, or a deletion.
fn platform_changes(files: &CaptureFiles) -> Result<Vec<Value>> {
    let mut total = 0usize;
    files
        .edits
        .iter()
        .map(|(path, edit)| match edit {
            TreeEdit::Delete => Ok(json!({"path":path,"delete":true})),
            TreeEdit::Set { mode, .. } => {
                let file = files
                    .after
                    .get(path)
                    .ok_or_else(|| failure("Captured file bytes are unavailable"))?;
                let bytes = std::fs::read(&file.file)
                    .map_err(|_| failure("Captured file bytes are unavailable"))?;
                total = total.saturating_add(bytes.len());
                if total > MAX_UPLOAD_BYTES as usize {
                    return Err(failure("Captured changes exceed the commit capability"));
                }
                let kind = if *mode == 0o100755 { "exec" } else { "blob" };
                Ok(json!({"path":path,"type":kind,"content_b64":STANDARD.encode(bytes)}))
            }
        })
        .collect()
}

pub(crate) async fn execute_with(job: &Value, api: &CaptureApi) -> Result<Value> {
    let id = job["id"]
        .as_str()
        .ok_or_else(|| failure("Trusted capture job identity missing"))?;
    let epoch = job["epoch"]
        .as_i64()
        .filter(|v| *v >= 1)
        .ok_or_else(|| failure("Trusted capture epoch missing"))?;
    if job["kind"] != "capture" || job["payload"]["capture_subtype"] != "source_changeset" {
        return Err(failure("Invalid trusted source capture job"));
    }
    let context = api.context().await?;
    let changes = api.manifest(&context, "changes").await?;
    let overrides = api.manifest(&context, "overrides").await?;
    let manifest = assemble_manifest(
        &context.binding,
        &context.header,
        changes,
        overrides,
        &context.digest,
    )?;
    let directory =
        tempfile::tempdir().map_err(|_| failure("Private capture directory unavailable"))?;
    let mut objects = SourceGitObjects::create(&directory.path().join("objects"))
        .map_err(|_| failure("Trusted incremental Git initialization failed"))?;
    let mut trees = TreeCache::new();
    let files = prepare(
        api,
        &context.binding,
        &manifest,
        &context.digest,
        directory.path(),
        &mut objects,
        &mut trees,
    )
    .await?;
    let tree = rewrite_tree(
        &mut objects,
        &context.binding.base.tree,
        &files.edits,
        &mut |path, _| trees.base_directory(path),
    )
    .map_err(|_| failure("Incremental tree construction failed"))?;
    let message = format!("YonedaRepo sealed source {}", context.digest);
    let diff = touched_diff(&files.before, &files.after)
        .map_err(|_| failure("Real touched-path Git diff generation failed or exceeded 24 MiB"))?;
    let committed = api
        .json(
            "commit",
            json!({"parents":context.binding.parents,"tree":tree,"message":message,"changes":platform_changes(&files)?}),
        )
        .await?;
    if committed["verified"] != true
        || committed["tree"] != tree
        || committed["parents"] != json!(context.binding.parents)
        || committed["revision"]["repository"] != context.binding.base.repository
        || committed["revision"]["commit"].as_str().is_none()
    {
        return Err(failure(
            "Independent platform commit/tree/parent readback differs",
        ));
    }
    let commit = committed["revision"]["commit"].clone();
    let strategy = job["payload"]["execution"]["strategy"]
        .as_str()
        .unwrap_or("Candidate");
    let mut result = json!({"id":format!("candidate:{id}:{epoch}"),"revision":committed["revision"],"commit":commit,"tree":tree,"paths":files.edits.keys().collect::<Vec<_>>(),"summary":format!("{strategy} approach"),"parents":context.binding.parents,"diff":diff,"source_changeset_digest":context.digest,"source_manifest_digest":context.digest});
    // Integrator captures attest the frozen integration manifest.
    if let Some(digest) = job["payload"].get("integration_digest") {
        result["integration_digest"] = digest.clone();
    }
    Ok(result)
}
