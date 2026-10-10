use crate::{err, materialize};
use serde_json::{Value, json};
use std::path::Path;
use tokio::process::Command;
use yoneda_core::{Result, Workspace};
const GIT: &str = "/usr/bin/git";
pub async fn git(root: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&git_raw(root, args).await?)
        .trim()
        .to_owned())
}
pub(crate) async fn git_raw(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let secret = std::env::var("SUPERVISOR_TOKEN").ok();
    // Agent workspaces are intentionally chowned to UID 1000. Root-owned
    // supervisor reads may trust this one canonical checkout path only.
    let safe_directory = format!(
        "safe.directory={}",
        root.canonicalize().map_err(err)?.display()
    );
    let mut command = Command::new(GIT);
    command.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.attributesFile=/dev/null",
        "-c",
        "core.excludesFile=/dev/null",
        "-c",
        "core.fileMode=true",
        "-c",
        "protocol.file.allow=never",
    ]);
    command.arg("-c").arg(safe_directory);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/nonexistent")
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_CONFIG_COUNT", "7")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", "/dev/null")
        .env("GIT_CONFIG_KEY_1", "core.attributesFile")
        .env("GIT_CONFIG_VALUE_1", "/dev/null")
        .env("GIT_CONFIG_KEY_2", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_2", "never")
        .env("GIT_CONFIG_KEY_3", "core.excludesFile")
        .env("GIT_CONFIG_VALUE_3", "/dev/null")
        .env("GIT_CONFIG_KEY_4", "core.fileMode")
        .env("GIT_CONFIG_VALUE_4", "true")
        .env("GIT_CONFIG_KEY_5", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_5", "false")
        .env("GIT_CONFIG_KEY_6", "credential.helper")
        .env("GIT_CONFIG_VALUE_6", "");
    if let Some(secret) = secret {
        command
            .env("GIT_CONFIG_COUNT", "8")
            .env("GIT_CONFIG_KEY_7", "http.extraHeader")
            .env(
                "GIT_CONFIG_VALUE_7",
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

pub(crate) use crate::{
    git_capture::capture_fresh,
    git_revision::{read_git_revision, verify_git_parent},
};

/// Trusted capture reconstructs a fresh Git tree. It never opens the agent's .git directory.
pub async fn capture(
    root: &Path,
    base: Option<&str>,
    workspace: &Workspace,
    message: &str,
) -> Result<Value> {
    std::fs::create_dir_all(root).map_err(err)?;
    let git_dir = root.join(".git");
    if let Ok(metadata) = std::fs::symlink_metadata(&git_dir) {
        if metadata.file_type().is_symlink() || metadata.is_file() {
            std::fs::remove_file(&git_dir).map_err(err)?;
        } else {
            for name in ["config", "config.worktree"] {
                let config = git_dir.join(name);
                if std::fs::symlink_metadata(&config).is_ok() {
                    std::fs::remove_file(&config).map_err(err)?;
                }
            }
        }
    }
    git(root, &["init", "-b", "main"]).await?;
    materialize(root, workspace)?;
    git(root, &["add", "--force", "--all"]).await?;
    let tree = git(root, &["write-tree"]).await?;
    let mut command = Command::new(GIT);
    command
        .env_clear()
        .current_dir(root)
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/nonexistent")
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", "/dev/null")
        .env("GIT_CONFIG_KEY_1", "core.attributesFile")
        .env("GIT_CONFIG_VALUE_1", "/dev/null")
        .env("GIT_CONFIG_KEY_2", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_2", "never")
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
        git_raw(
            root,
            &["diff", "--no-renames", "--name-only", "-z", base, &commit],
        )
        .await?
    } else {
        git_raw(root, &["ls-tree", "-r", "--name-only", "-z", &commit]).await?
    };
    let paths: Vec<String> = paths
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8(path.to_vec()).map_err(err))
        .collect::<Result<_>>()?;
    let diff = if let Some(base) = base {
        String::from_utf8_lossy(&git_raw(root, &["diff", "--no-ext-diff", base, &commit]).await?)
            .into_owned()
    } else {
        String::from_utf8_lossy(
            &git_raw(root, &["show", "--format=", "--no-ext-diff", &commit]).await?,
        )
        .into_owned()
    };
    Ok(json!({"commit":commit,"tree":tree,"paths":paths,"diff":diff}))
}

#[cfg(all(test, target_os = "linux"))]
mod ownership_tests {
    use super::git;
    use std::os::unix::fs::MetadataExt;
    use tokio::process::Command;

    #[tokio::test]
    async fn root_can_read_only_the_agent_owned_checkout_after_chown() {
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let checkout = tempfile::tempdir().expect("temporary checkout");
        git(checkout.path(), &["init", "-b", "main"])
            .await
            .expect("initialize root-owned checkout");
        let status = Command::new("/usr/bin/chown")
            .args(["-R", "1000:1000"])
            .arg(checkout.path())
            .status()
            .await
            .expect("run chown");
        assert!(status.success(), "chown fixture to the agent uid");
        assert_eq!(std::fs::metadata(checkout.path()).unwrap().uid(), 1000);

        let top = git(checkout.path(), &["rev-parse", "--show-toplevel"])
            .await
            .expect("trusted root Git must read the exact agent checkout");
        assert_eq!(top, checkout.path().to_string_lossy());
    }
}
