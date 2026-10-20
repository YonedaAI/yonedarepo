//! Complete incremental trusted capture; Git/Artifacts readback remains the result authority.
use crate::{
    source_capture_api::{CaptureApi, failure},
    source_capture_diff::touched_diff,
    source_capture_files::prepare,
    source_capture_manifest::assemble_manifest,
    source_capture_trees::TreeCache,
    source_git::SourceGitObjects,
    source_git_http::SourceGitHttp,
    source_git_rewrite::rewrite_tree,
};
use serde_json::{Value, json};
use yoneda_core::{Result, source_workspace::MAX_UPLOAD_BYTES};

pub(crate) async fn execute(job: &Value) -> Result<Value> {
    if job["kind"] != "capture" || job["payload"]["capture_subtype"] != "source_changeset" {
        return Err(failure(
            "Capture job is not approved for API-source transport",
        ));
    }
    let api = CaptureApi::from_root()?;
    let authorization = std::env::var("SUPERVISOR_TOKEN")
        .map(|token| format!("Bearer {token}"))
        .map_err(|_| failure("Root Git authorization missing"))?;
    let git = SourceGitHttp::new("http://git.yoneda.internal/candidate", Some(&authorization))
        .map_err(|_| failure("Scoped candidate Git proxy unavailable"))?;
    execute_with(job, &api, &git).await
}
pub(crate) async fn execute_with(
    job: &Value,
    api: &CaptureApi,
    git: &SourceGitHttp,
) -> Result<Value> {
    let id = job["id"]
        .as_str()
        .ok_or_else(|| failure("Trusted capture job identity missing"))?;
    let epoch = job["epoch"]
        .as_i64()
        .filter(|v| *v >= 1)
        .ok_or_else(|| failure("Trusted capture epoch missing"))?;
    if job["kind"] != "capture"
        || job["payload"]["capture_subtype"] != "source_changeset"
        || job["fork"].as_str().is_none_or(str::is_empty)
    {
        return Err(failure("Invalid trusted source capture job"));
    }
    let branch = job["source_capture_ref"]["branch"]
        .as_str()
        .ok_or_else(|| failure("Frozen capture fork branch missing"))?;
    let reference = format!("refs/heads/{branch}");
    crate::source_git_protocol::validate_ref(&reference)
        .map_err(|_| failure("Invalid frozen capture fork branch"))?;
    let expected_head = job["source_capture_ref"]["expected_head"]
        .as_str()
        .ok_or_else(|| failure("Frozen capture fork expected head missing"))?;
    crate::source_git_tree::validate_oid(expected_head)
        .map_err(|_| failure("Frozen capture fork head requires Git SHA-1"))?;
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
    let commit = objects
        .commit(&tree, &context.binding.parents, &message)
        .map_err(|_| failure("Trusted deterministic commit construction failed"))?;
    let diff = touched_diff(&files.before, &files.after)
        .map_err(|_| failure("Real touched-path Git diff generation failed or exceeded 24 MiB"))?;
    let pack = objects
        .pack(MAX_UPLOAD_BYTES)
        .map_err(|_| failure("Explicit incremental pack exceeds its capability"))?;
    let push = git
        .push_ref(&reference, expected_head, &commit, &pack, MAX_UPLOAD_BYTES)
        .await
        .map_err(|_| failure("Incremental Git push or ref readback failed"))?;
    let verified = api
        .json(
            "verify",
            json!({"commit":commit,"tree":tree,"parents":context.binding.parents}),
        )
        .await?;
    if verified["verified"] != true
        || verified["revision"]["commit"] != commit
        || verified["tree"] != tree
        || verified["parents"] != json!(context.binding.parents)
        || verified["revision"]["repository"] != job["fork"]
    {
        return Err(failure(
            "Independent Worker commit/tree/parent readback differs",
        ));
    }
    let strategy = job["payload"]["execution"]["strategy"]
        .as_str()
        .unwrap_or("Candidate");
    let mut result = json!({"id":format!("candidate:{id}:{epoch}"),"revision":verified["revision"],"commit":commit,"tree":tree,"paths":files.edits.keys().collect::<Vec<_>>(),"summary":format!("{strategy} approach"),"parents":context.binding.parents,"diff":diff,"source_changeset_digest":context.digest,"source_manifest_digest":context.digest,"incremental_capture":{"version":1,"recovered_ack":push.recovered_ack,"pack_uploaded":push.uploaded}});
    // Integrator captures attest the frozen integration manifest.
    if let Some(digest) = job["payload"].get("integration_digest") {
        result["integration_digest"] = digest.clone();
    }
    Ok(result)
}
