use crate::{err, materialize};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use yoneda_core::{Result, Workspace};
pub async fn git(root: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&git_raw(root, args).await?)
        .trim()
        .to_owned())
}
async fn git_raw(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "protocol.file.allow=never",
    ]);
    if let Ok(secret) = std::env::var("SUPERVISOR_TOKEN") {
        command
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env(
                "GIT_CONFIG_VALUE_0",
                format!("Authorization: Bearer {secret}"),
            );
    }
    let output = command
        .args(args)
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(err)?;
    if !output.status.success() {
        return Err(err(String::from_utf8_lossy(&output.stderr)));
    }
    Ok(output.stdout)
}

/// Trusted capture reconstructs a fresh Git tree. It never opens the agent's .git directory.
pub async fn capture(
    root: &Path,
    base: Option<&str>,
    workspace: &Workspace,
    message: &str,
) -> Result<Value> {
    std::fs::create_dir_all(root).map_err(err)?;
    git(root, &["init", "-b", "main"]).await?;
    materialize(root, workspace)?;
    git(root, &["add", "--force", "--all"]).await?;
    let tree = git(root, &["write-tree"]).await?;
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args(["commit-tree", &tree, "-m", message]);
    if let Some(parent) = base {
        command.args(["-p", parent]);
    }
    let output = command
        .env("GIT_AUTHOR_NAME", "YonedaRepo capture")
        .env("GIT_AUTHOR_EMAIL", "capture@yoneda.invalid")
        .env("GIT_COMMITTER_NAME", "YonedaRepo capture")
        .env("GIT_COMMITTER_EMAIL", "capture@yoneda.invalid")
        .env("GIT_AUTHOR_DATE", "2026-10-07T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-10-07T00:00:00Z")
        .output()
        .await
        .map_err(err)?;
    if !output.status.success() {
        return Err(err(String::from_utf8_lossy(&output.stderr)));
    }
    let commit = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    git(root, &["update-ref", "refs/heads/main", &commit]).await?;
    let paths = if let Some(base) = base {
        git_raw(root, &["diff", "--name-only", "-z", base, &commit]).await?
    } else {
        git_raw(root, &["ls-tree", "-r", "--name-only", "-z", &commit]).await?
    };
    let paths: Vec<String> = paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8(path.to_vec()).map_err(err))
        .collect::<Result<_>>()?;
    let diff = if let Some(base) = base {
        String::from_utf8(git_raw(root, &["diff", "--no-ext-diff", base, &commit]).await?)
            .map_err(err)?
    } else {
        String::from_utf8(git_raw(root, &["show", "--format=", "--no-ext-diff", &commit]).await?)
            .map_err(err)?
    };
    Ok(json!({"commit":commit,"tree":tree,"paths":paths,"diff":diff}))
}
