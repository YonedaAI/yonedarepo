//! API resolvers preserve the trusted premerged workspace and exact target lease.
use super::*;
pub(super) fn record<S: SqlStore>(db: &S, job: &Value, e: &Value) -> Result<Option<Value>> {
    let Some(id) = e["conflict_id"].as_str() else {
        return Ok(None);
    };
    let mut record = get(db, "conflicts", id)?;
    if !record["conflict_paths_ref"].is_null() {
        record["conflict_paths"] = json!(crate::path_lists::load(db, &record, "conflict_paths")?);
    }
    if record["status"] != "resolving"
        || record["resolver_job_id"] != job["id"]
        || record["resolver_execution_id"] != e["id"]
        || job["payload"]["conflict_resolver"]["conflict_id"] != id
        || e["base"] != record["target_revision"]
        || record["candidate"]["run_id"] != e["run_id"]
        || e["conflict_paths"] != record["conflict_paths"]
    {
        return Err(Error::new(
            "FENCED",
            "Resolver source identity differs from frozen conflict",
        ));
    }
    validate_target(db, &record)?;
    crate::commands::conflicts::validate_source_resolution(db, &record)?;
    Ok(Some(record))
}
pub(super) fn validate_target<S: SqlStore>(db: &S, record: &Value) -> Result<()> {
    let repository = repo(db)?;
    let (revision, version) = if let Some(id) = record["working_branch_id"].as_str() {
        let branch = get(db, "working_branches", id)?;
        if branch["status"] != "active" {
            return Err(Error::new("HEAD_MOVED", "Resolver branch inactive"));
        }
        (
            branch["working_revision"].clone(),
            branch["version"].clone(),
        )
    } else {
        (
            json!({"repository":record["target_revision"]["repository"],"commit":repository["head_commit"]}),
            repository["version"].clone(),
        )
    };
    if repository["status"] != "ready"
        || !repository["pending"].is_null()
        || revision != record["target_revision"]
        || version != record["expected_version"]
    {
        return Err(Error::new("HEAD_MOVED", "Resolver target lease changed"));
    }
    Ok(())
}
pub(super) fn revisions(
    record: &Value,
) -> Result<(SourceRevision, SourceRevision, SourceRevision)> {
    let base = SourceRevision {
        repository: string(&record["target_revision"], "repository")?,
        commit: string(record, "head_commit")?,
        tree: hash(record, "expected_head_tree", &[40, 64])?,
    };
    let merge = SourceRevision {
        repository: string(&record["workspace_revision"], "repository")?,
        commit: hash(record, "merge_workspace_commit", &[40, 64])?,
        tree: hash(record, "merge_tree", &[40, 64])?,
    };
    let candidate = SourceRevision {
        repository: string(&record["candidate"]["revision"], "repository")?,
        commit: hash(record, "candidate_revision", &[40, 64])?,
        tree: hash(&record["candidate"], "tree", &[40, 64])?,
    };
    if record["workspace_revision"]["commit"] != merge.commit
        || record["candidate"]["revision"]["commit"] != candidate.commit
    {
        return Err(Error::new("FENCED", "Resolver merge inputs changed"));
    }
    for r in [&base, &merge, &candidate] {
        r.validate()?;
    }
    Ok((base, merge, candidate))
}
pub(super) fn baseline<S: SqlStore>(db: &S, record: &Value) -> Result<Vec<Value>> {
    let (_, merge, _) = revisions(record)?;
    if record["merged_paths_ref"].is_null() && record.get("merged_paths").is_none() {
        return Err(Error::new(
            "SOURCE_PREPARING",
            "Trusted premerged path metadata is missing",
        ));
    }
    Ok(vec![
        json!({"revision":{"repository":merge.repository,"commit":merge.commit},"tree":merge.tree,"paths":crate::path_lists::load(db,record,"merged_paths")?}),
    ])
}
pub(super) fn validate_binding_head<S: SqlStore>(db: &S, b: &SourceBinding) -> Result<bool> {
    let e = get(db, "executions", &b.execution_id)?;
    let Some(id) = e["conflict_id"].as_str() else {
        return Ok(false);
    };
    let record = get(db, "conflicts", id)?;
    let (base, _, candidate) = revisions(&record)?;
    if b.base != base
        || b.parents != vec![base.commit.clone(), candidate.commit]
        || b.working_branch_id != record["working_branch_id"].as_str().map(str::to_owned)
        || (b.working_branch_id.is_some()
            && json!(b.working_branch_version) != record["expected_version"])
        || (b.working_branch_id.is_none()
            && json!(b.repo_base_version) != record["expected_version"])
    {
        return Err(Error::new("FENCED", "Resolver binding target differs"));
    }
    validate_target(db, &record)?;
    Ok(true)
}
