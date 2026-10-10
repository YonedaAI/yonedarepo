//! Exact-revision Git reads and approved-parent validation.
use crate::{
    err,
    git::{git, git_raw},
};
use std::path::Path;
use tokio::process::Command;
use yoneda_core::Result;

pub(crate) async fn read_git_revision(
    remote: &str,
    commit: &str,
) -> Result<crate::transport::GitWorkspace> {
    validate_revision(commit)?;
    let repository = tempfile::tempdir().map_err(err)?;
    git(repository.path(), &["init", "-b", "main"]).await?;
    fetch_git(repository.path(), remote, commit).await?;
    read_fetched_tree(repository.path(), "FETCH_HEAD").await
}

pub(crate) async fn verify_git_parent(remote: &str, commit: &str, expected: &str) -> Result<()> {
    verify_git_parents(remote, commit, &[expected]).await
}

/// Verify exact, ordered parents frozen by trusted capture metadata.
pub(crate) async fn verify_git_parents(
    remote: &str,
    commit: &str,
    expected: &[&str],
) -> Result<()> {
    validate_revision(commit)?;
    if expected.is_empty() || expected.len() > 2 {
        return Err(err("Invalid frozen Git parent list"));
    }
    for parent in expected {
        validate_revision(parent)?;
    }
    let repository = tempfile::tempdir().map_err(err)?;
    git(repository.path(), &["init", "-b", "main"]).await?;
    fetch_git(repository.path(), remote, commit).await?;
    let parents = git(
        repository.path(),
        &["rev-list", "--parents", "-n", "1", "FETCH_HEAD"],
    )
    .await?;
    let revisions = parents.split_whitespace().collect::<Vec<_>>();
    if revisions.len() != expected.len() + 1
        || revisions[0] != commit
        || revisions[1..] != *expected
    {
        return Err(err(
            "Captured Git revision parents differ from the frozen approved parent list",
        ));
    }
    Ok(())
}

async fn read_fetched_tree(root: &Path, revision: &str) -> Result<crate::transport::GitWorkspace> {
    let listing = git_raw(root, &["ls-tree", "-rz", "--full-tree", revision]).await?;
    let mut files = crate::transport::GitWorkspace::new();
    let mut size = 0usize;
    for record in listing
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        let separator = record
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| err("Malformed Git tree"))?;
        let (header, name) = (&record[..separator], &record[separator + 1..]);
        let fields = std::str::from_utf8(header)
            .map_err(err)?
            .split_ascii_whitespace()
            .collect::<Vec<_>>();
        if fields.len() != 3 || fields[1] != "blob" || !["100644", "100755"].contains(&fields[0]) {
            return Err(err(
                "Git tree contains a symlink, submodule or nonregular entry",
            ));
        }
        let path = std::str::from_utf8(name).map_err(err)?.to_owned();
        yoneda_core::validate_path(&path)?;
        let bytes = git_raw(root, &["cat-file", "blob", fields[2]]).await?;
        size = size.saturating_add(bytes.len());
        if files.len() >= 10_000 || size > 100 * 1024 * 1024 || bytes.len() > 32_000_000 {
            return Err(err("Git workspace exceeds file or byte limits"));
        }
        files.insert(
            path,
            crate::transport::GitFile {
                bytes,
                executable: fields[0] == "100755",
            },
        );
    }
    if files.is_empty() {
        return Err(err("Git workspace is empty"));
    }
    validate_shape(&files)?;
    Ok(files)
}

pub(crate) async fn fetch_git(root: &Path, remote: &str, commit: &str) -> Result<()> {
    let secret = std::env::var("SUPERVISOR_TOKEN").ok();
    let mut command = Command::new("/usr/bin/git");
    command.args(["-c", "protocol.file.allow=never"]);
    if Path::new(remote).is_absolute() {
        command.args(["-c", "protocol.file.allow=always"]);
    }
    command
        .args(["fetch", "--no-tags", remote, commit])
        .current_dir(root)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", "/nonexistent")
        .env("LANG", "C.UTF-8")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "5")
        .env("GIT_CONFIG_KEY_0", "core.hooksPath")
        .env("GIT_CONFIG_VALUE_0", "/dev/null")
        .env("GIT_CONFIG_KEY_1", "core.attributesFile")
        .env("GIT_CONFIG_VALUE_1", "/dev/null")
        .env("GIT_CONFIG_KEY_2", "protocol.file.allow")
        .env("GIT_CONFIG_VALUE_2", "never")
        .env("GIT_CONFIG_KEY_3", "core.fsmonitor")
        .env("GIT_CONFIG_VALUE_3", "false")
        .env("GIT_CONFIG_KEY_4", "credential.helper")
        .env("GIT_CONFIG_VALUE_4", "");
    if let Some(secret) = secret {
        command
            .env("GIT_CONFIG_COUNT", "6")
            .env("GIT_CONFIG_KEY_5", "http.extraHeader")
            .env(
                "GIT_CONFIG_VALUE_5",
                format!("Authorization: Bearer {secret}"),
            );
    }
    let output = command.output().await.map_err(err)?;
    if !output.status.success() {
        return Err(err(String::from_utf8_lossy(&output.stderr)));
    }
    Ok(())
}

pub(crate) fn validate_revision(revision: &str) -> Result<()> {
    if ![40, 64].contains(&revision.len()) || !revision.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(err("Invalid Git revision"));
    }
    Ok(())
}

pub(crate) fn validate_shape(files: &crate::transport::GitWorkspace) -> Result<()> {
    for path in files.keys() {
        yoneda_core::validate_path(path)?;
        let mut prefix = path.as_str();
        while let Some((parent, _)) = prefix.rsplit_once('/') {
            if files.contains_key(parent) {
                return Err(err("Git file is also a parent directory"));
            }
            prefix = parent;
        }
    }
    Ok(())
}
