//! Trusted fresh-repository capture and exact Team workspace seeding.
use crate::{
    err,
    git::{git, git_raw},
    git_revision::{fetch_git, validate_revision, validate_shape},
};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use yoneda_core::Result;

pub(crate) async fn capture_fresh(
    root: &Path,
    canonical: &str,
    base: &str,
    files: &crate::transport::GitWorkspace,
    message: &str,
) -> Result<Value> {
    crate::process_guard::terminate_attempt()?;
    validate_revision(base)?;
    validate_shape(files)?;
    let staging = tempfile::tempdir().map_err(err)?;
    git(staging.path(), &["init", "-b", "main"]).await?;
    fetch_git(staging.path(), canonical, base).await?;
    crate::transport::materialize_git(staging.path(), files)?;
    git(staging.path(), &["add", "--force", "--all"]).await?;
    let tree = git(staging.path(), &["write-tree"]).await?;
    let output = Command::new("/usr/bin/git")
        .current_dir(staging.path())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/nonexistent")
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_AUTHOR_NAME", "YonedaRepo capture")
        .env("GIT_AUTHOR_EMAIL", "capture@yoneda.invalid")
        .env("GIT_COMMITTER_NAME", "YonedaRepo capture")
        .env("GIT_COMMITTER_EMAIL", "capture@yoneda.invalid")
        .env("GIT_AUTHOR_DATE", "2026-10-07T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-10-07T00:00:00Z")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "commit-tree",
            &tree,
            "-p",
            base,
            "-m",
            message,
        ])
        .output()
        .await
        .map_err(err)?;
    if !output.status.success() {
        return Err(err(String::from_utf8_lossy(&output.stderr)));
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    git(staging.path(), &["update-ref", "refs/heads/main", &commit]).await?;
    let raw_paths = git_raw(
        staging.path(),
        &["diff", "--no-renames", "--name-only", "-z", base, &commit],
    )
    .await?;
    let paths = raw_paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8(path.to_vec()).map_err(err))
        .collect::<Result<Vec<_>>>()?;
    let stat = git_raw(
        staging.path(),
        &["diff", "--stat", "--no-ext-diff", base, &commit],
    )
    .await?;
    let diff = String::from_utf8_lossy(&stat)
        .chars()
        .take(65_536)
        .collect::<String>();
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(err)?;
    }
    std::fs::create_dir_all(root).map_err(err)?;
    copy_tree(staging.path(), root)?;
    Ok(json!({"commit":commit,"tree":tree,"paths":paths,"diff":diff}))
}

pub(crate) async fn seed_workspace(
    root: &Path,
    base: &str,
    files: &crate::transport::GitWorkspace,
) -> Result<String> {
    validate_shape(files)?;
    clear_worktree(root)?;
    crate::transport::materialize_git(root, files)?;
    git(root, &["add", "--force", "--all"]).await?;
    let tree = git(root, &["write-tree"]).await?;
    let output = Command::new("/usr/bin/git")
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/nonexistent")
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "YonedaRepo team assembly")
        .env("GIT_AUTHOR_EMAIL", "capture@yoneda.invalid")
        .env("GIT_COMMITTER_NAME", "YonedaRepo team assembly")
        .env("GIT_COMMITTER_EMAIL", "capture@yoneda.invalid")
        .env("GIT_AUTHOR_DATE", "2026-10-07T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-10-07T00:00:00Z")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "commit-tree",
            &tree,
            "-p",
            base,
            "-m",
            "YonedaRepo exact Team inputs",
        ])
        .output()
        .await
        .map_err(err)?;
    if !output.status.success() {
        return Err(err(String::from_utf8_lossy(&output.stderr)));
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    git(root, &["update-ref", "refs/heads/main", &commit]).await?;
    git(root, &["push", "--force", "origin", "HEAD:refs/heads/main"]).await?;
    Ok(commit)
}

fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    for entry in std::fs::read_dir(from).map_err(err)? {
        let entry = entry.map_err(err)?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        if entry.file_type().map_err(err)?.is_dir() {
            std::fs::create_dir_all(&target).map_err(err)?;
            copy_tree(&source, &target)?;
        } else if entry.file_type().map_err(err)?.is_file() {
            std::fs::copy(source, target).map_err(err)?;
        } else {
            return Err(err("Trusted staging tree contains a nonregular entry"));
        }
    }
    Ok(())
}

fn clear_worktree(root: &Path) -> Result<()> {
    for entry in std::fs::read_dir(root).map_err(err)? {
        let entry = entry.map_err(err)?;
        if entry.file_name() != ".git" {
            remove_entry(&entry.path())?;
        }
    }
    Ok(())
}

fn remove_entry(path: &Path) -> Result<()> {
    let kind = std::fs::symlink_metadata(path).map_err(err)?.file_type();
    if kind.is_symlink() || kind.is_file() {
        std::fs::remove_file(path).map_err(err)
    } else if kind.is_dir() {
        for child in std::fs::read_dir(path).map_err(err)? {
            remove_entry(&child.map_err(err)?.path())?;
        }
        std::fs::remove_dir(path).map_err(err)
    } else {
        Err(err("Workspace contains a nonregular entry"))
    }
}
