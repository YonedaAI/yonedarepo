//! Frozen three-input metadata/changed-byte merge with bounded candidate closure preload.
use crate::{
    source_capture_diff::touched_diff,
    source_git::SourceGitObjects,
    source_git_http::SourceGitHttp,
    source_git_rewrite::rewrite_tree,
    source_refresh_api::Api,
    source_refresh_merge::merge,
    source_refresh_metadata::walk,
    source_refresh_plan::{derive, error},
    source_refresh_upload::Upload,
};
use serde_json::{Value, json};
use yoneda_core::{Result, source_workspace::MAX_UPLOAD_BYTES};
pub(crate) async fn execute(job: &Value) -> Result<Value> {
    validate_job(job)?;
    let token = std::env::var("SUPERVISOR_TOKEN")
        .map_err(|_| error("Root refresh authorization unavailable"))?;
    let api = Api::new("http://source.yoneda.internal", &token)?;
    let auth = format!("Bearer {token}");
    let git = SourceGitHttp::new("http://git.yoneda.internal/fork", Some(&auth))
        .map_err(|_| error("Assigned fork proxy unavailable"))?;
    let source = Upload::new("http://git.yoneda.internal/refresh-candidate", Some(&auth))?;
    execute_with(job, &api, &git, &source).await
}
fn validate_job(job: &Value) -> Result<()> {
    if job["kind"] != "capture"
        || job["payload"]["capture_subtype"] != "refresh_candidate"
        || job["payload"]["workspace_transport"] != "api-source-v1"
        || job["id"].as_str().is_none_or(str::is_empty)
        || job["fork"].as_str().is_none_or(str::is_empty)
        || job["epoch"].as_i64().is_none_or(|v| v < 1)
    {
        return Err(error("Job is not a trusted API-source refresh capture"));
    }
    Ok(())
}
pub(crate) async fn execute_with(
    job: &Value,
    api: &Api,
    git: &SourceGitHttp,
    source: &Upload,
) -> Result<Value> {
    validate_job(job)?;
    let context = api.context().await?;
    if job["payload"]["expected_base"] != context.base.commit
        || job["payload"]["expected_head"] != context.head.commit
        || job["payload"]["candidate"]["revision"]["commit"] != context.candidate.commit
    {
        return Err(error("Refresh context differs from reserved job revisions"));
    }
    let directory =
        tempfile::tempdir().map_err(|_| error("Private refresh directory unavailable"))?;
    let mut store = SourceGitObjects::create(&directory.path().join("objects"))
        .map_err(|_| error("Trusted refresh Git store unavailable"))?;
    let base = walk(api, &store, "base", &context.base.tree).await?;
    let head = walk(api, &store, "head", &context.head.tree).await?;
    let candidate = walk(api, &store, "candidate", &context.candidate.tree).await?;
    let plan = derive(
        &base.files,
        &head.files,
        &candidate.files,
        &context.declared,
    )?;
    let merged = merge(
        api,
        &mut store,
        directory.path(),
        &base.files,
        &head.files,
        &candidate.files,
        &plan,
    )
    .await?;
    let tree = rewrite_tree(
        &mut store,
        &context.head.tree,
        &merged.edits,
        &mut |path, _| {
            head.directories
                .get(path)
                .cloned()
                .ok_or_else(|| std::io::Error::other("Frozen head ancestor missing"))
        },
    )
    .map_err(|_| error("Sparse refresh tree construction failed"))?;
    let parents = vec![
        context.head.commit.clone(),
        context.candidate.commit.clone(),
    ];
    let commit = store
        .commit(&tree, &parents, "YonedaRepo sparse refresh workspace")
        .map_err(|_| error("Trusted two-parent refresh commit failed"))?;
    let diff = touched_diff(&merged.before, &merged.after)
        .map_err(|_| error("Real refresh binary diff failed or exceeds 24 MiB"))?;
    let input_pack = directory.path().join("candidate-input.pack");
    source
        .difference(
            &context.candidate.commit,
            &context.base.commit,
            &input_pack,
            MAX_UPLOAD_BYTES,
        )
        .await?;
    let id = job["id"]
        .as_str()
        .ok_or_else(|| error("Refresh job identity missing"))?;
    let input_ref = format!(
        "refs/yoneda/source-input/{}",
        yoneda_core::digest(id.as_bytes())
    );
    let preload = git
        .push_input_ref(
            &input_ref,
            &context.candidate.commit,
            &input_pack,
            MAX_UPLOAD_BYTES,
        )
        .await
        .map_err(|_| error("Candidate-minus-base closure preload failed"))?;
    let verified_input = api.json("verify_input", json!({})).await?;
    if verified_input["verified"] != true
        || verified_input["revision"]["repository"] != job["fork"]
        || verified_input["revision"]["commit"] != context.candidate.commit
        || verified_input["tree"] != context.candidate.tree
        || verified_input["parents"] != json!(context.candidate_parents)
    {
        return Err(error("Assigned fork candidate input readback differs"));
    }
    let pack = store
        .pack(MAX_UPLOAD_BYTES)
        .map_err(|_| error("Sparse refresh pack exceeds capability"))?;
    let pushed = git
        .push_ref(
            &format!("refs/heads/{}", context.branch),
            &context.expected_head,
            &commit,
            &pack,
            MAX_UPLOAD_BYTES,
        )
        .await
        .map_err(|_| error("Assigned refresh branch lease or readback failed"))?;
    let verified = api
        .json(
            "verify",
            json!({"commit":commit,"tree":tree,"parents":parents}),
        )
        .await?;
    if verified["verified"] != true
        || verified["revision"]["repository"] != job["fork"]
        || verified["revision"]["commit"] != commit
        || verified["tree"] != tree
        || verified["parents"] != json!(parents)
    {
        return Err(error(
            "Authoritative refresh commit/tree/parent readback differs",
        ));
    }
    let clean = merged.conflicts.is_empty();
    Ok(
        json!({"evidence":{"base_commit":context.base.commit,"observed_head":context.head.commit,"candidate_commit":context.candidate.commit,"declared_paths":context.declared,"captured_paths":plan.captured,"intervening_paths":plan.intervening,"overlapping_paths":plan.overlapping},"merge_commit":if clean{Some(&commit)}else{None},"merge_tree":tree,"candidate_id":if clean{Some(format!("candidate:refresh:{commit}"))}else{None},"revision":if clean{Some(verified["revision"].clone())}else{None},"tree":tree,"paths":if clean{merged.edits.keys().cloned().collect::<Vec<_>>()}else{vec![]},"conflict_paths":merged.conflicts,"merge_workspace_commit":if clean{None}else{Some(&commit)},"merge_workspace_revision":if clean{None}else{Some(verified["revision"].clone())},"status":if clean{"clean"}else{"unresolved"},"diff":diff,"transport_receipt":{"repository":job["fork"],"commit":commit,"expected_head":context.head.commit,"canonical_repository":context.base.repository,"candidate_repository":context.candidate.repository,"tree":tree},"incremental_refresh":{"version":1,"target_version":context.version,"input_ack_recovered":preload.recovered_ack,"input_pack_uploaded":preload.uploaded,"merge_ack_recovered":pushed.recovered_ack,"merge_pack_uploaded":pushed.uploaded}}),
    )
}
