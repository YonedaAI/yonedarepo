//! Attempt-scoped Git-native workspace transport.
use crate::{err, git::git};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};
use yoneda_core::{Result, Workspace};

#[derive(Debug, Clone)]
pub(crate) struct GitFile {
    pub(crate) bytes: Vec<u8>,
    pub(crate) executable: bool,
}
pub(crate) type GitWorkspace = BTreeMap<String, GitFile>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ReadOnlySnapshot {
    commit: String,
    tree: String,
}

pub(crate) async fn snapshot_read_only(root: &Path) -> Result<ReadOnlySnapshot> {
    let commit = git(root, &["rev-parse", "HEAD^{commit}"]).await?;
    let tree = git(root, &["rev-parse", "HEAD^{tree}"]).await?;
    let snapshot = ReadOnlySnapshot { commit, tree };
    verify_read_only(root, &snapshot).await?;
    Ok(snapshot)
}

pub(crate) async fn verify_read_only(root: &Path, approved: &ReadOnlySnapshot) -> Result<()> {
    let commit = git(root, &["rev-parse", "HEAD^{commit}"]).await?;
    let tree = git(root, &["rev-parse", "HEAD^{tree}"]).await?;
    if commit != approved.commit || tree != approved.tree {
        return Err(err("Git planning changed the approved HEAD or tree"));
    }
    let status = crate::git::git_raw(
        root,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
        ],
    )
    .await?;
    if !status.is_empty() {
        return Err(err("Git planning left a dirty worktree"));
    }
    Ok(())
}

impl GitFile {
    pub(crate) fn from_entry(entry: yoneda_core::FileEntry) -> Result<Self> {
        Ok(Self {
            bytes: entry.bytes()?,
            executable: entry.executable,
        })
    }
}

pub(crate) fn from_legacy(workspace: Workspace) -> Result<GitWorkspace> {
    workspace
        .into_iter()
        .map(|(path, file)| Ok((path, GitFile::from_entry(file)?)))
        .collect()
}

pub(crate) fn materialize_git(root: &Path, files: &GitWorkspace) -> Result<()> {
    if files.is_empty() || files.len() > 10_000 {
        return Err(err("Workspace must contain 1–10,000 files"));
    }
    let mut total = 0usize;
    for (path, file) in files {
        yoneda_core::validate_path(path)?;
        if file.bytes.len() > 32_000_000 {
            return Err(err("Git blob exceeds 32 MB"));
        }
        total = total.saturating_add(file.bytes.len());
        if total > 100 * 1024 * 1024 {
            return Err(err("Workspace exceeds 100 MiB"));
        }
        let destination = root.join(path);
        std::fs::create_dir_all(
            destination
                .parent()
                .ok_or_else(|| err("Invalid workspace path"))?,
        )
        .map_err(crate::err)?;
        std::fs::write(&destination, &file.bytes).map_err(crate::err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                destination,
                std::fs::Permissions::from_mode(if file.executable { 0o755 } else { 0o644 }),
            )
            .map_err(crate::err)?;
        }
    }
    Ok(())
}

pub(crate) const GIT_NATIVE_V1: &str = "git-native-v1";

pub(crate) fn enabled(job: &Value) -> bool {
    job["payload"]["workspace_transport"].as_str() == Some(GIT_NATIVE_V1)
}

/// Clone the attempt fork with agent-owned Git history and a read-only canonical remote.
pub(crate) async fn prepare_agent_workspace(job: &Value, root: &Path) -> Result<()> {
    if !enabled(job) {
        return Err(err("Git-native transport was not frozen for this job"));
    }
    job["fork"]
        .as_str()
        .ok_or_else(|| err("Attempt fork is unavailable"))?;
    job["payload"]["execution"]["base"]["repository"]
        .as_str()
        .or_else(|| job["payload"]["base"]["repository"].as_str())
        .ok_or_else(|| err("Approved canonical repository is unavailable"))?;
    let base = job["payload"]["execution"]["base"]["commit"]
        .as_str()
        .or_else(|| job["payload"]["base"]["commit"].as_str())
        .ok_or_else(|| err("Approved canonical commit is unavailable"))?;
    let fork_url = "http://git.yoneda.internal/fork".to_owned();
    let canonical_url = "http://git.yoneda.internal/canonical".to_owned();
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(err)?;
    }
    let parent = root
        .parent()
        .ok_or_else(|| err("Workspace has no parent"))?;
    git(
        parent,
        &[
            "clone",
            "--",
            &fork_url,
            root.to_str().ok_or_else(|| err("Invalid workspace path"))?,
        ],
    )
    .await?;
    git(root, &["remote", "add", "canonical", &canonical_url]).await?;
    git(root, &["fetch", "canonical", base]).await?;
    git(root, &["checkout", "-B", "main", "FETCH_HEAD"]).await?;
    git(root, &["push", "--force", "origin", "HEAD:refs/heads/main"]).await?;
    if let Some(resolver) = job["payload"]["conflict_resolver"].as_object() {
        let repository = resolver["merge_workspace_repository"]
            .as_str()
            .ok_or_else(|| err("Frozen resolver merge-workspace repository is missing"))?;
        let commit = resolver["merge_workspace_commit"]
            .as_str()
            .ok_or_else(|| err("Frozen resolver merge-workspace revision is missing"))?;
        crate::git_revision::validate_revision(commit)?;
        git(
            root,
            &[
                "fetch",
                "http://git.yoneda.internal/merge-workspace",
                commit,
            ],
        )
        .await?;
        git(root, &["checkout", "-B", "main", "FETCH_HEAD"]).await?;
        git(root, &["push", "--force", "origin", "HEAD:refs/heads/main"]).await?;
        if repository.is_empty() {
            return Err(err("Invalid resolver merge-workspace repository"));
        }
    }
    if job["payload"]["team_inputs"].is_array() {
        let assembled = crate::team_source::load_git(job).await?;
        crate::git_capture::seed_workspace(root, base, &assembled).await?;
    }
    Ok(())
}

pub(crate) fn candidate_revision(job: &Value, commit: String) -> Value {
    json!({"repository":job["fork"],"commit":commit})
}
