//! Trusted, reproducible starter initialization. Browsers fork this Artifacts repository.
use crate::{
    live::api_authenticated,
    process::{Result, token},
};
use serde_json::json;
use std::path::Path;
use tokio::process::Command;
pub(crate) async fn seed_template(url: &str) -> Result<()> {
    seed_template_authenticated(url, &token()?).await
}
pub(crate) async fn seed_template_authenticated(url: &str, secret: &str) -> Result<()> {
    let name = "yoneda-website-starter";
    let bootstrap = api_authenticated(url, "bootstrap", Some(json!({"name":name})), secret).await?;
    if let Some(commit) = bootstrap["commit"].as_str() {
        println!("Website starter already exists: {commit}");
        return Ok(());
    }
    let root = tempfile::tempdir()?;
    let commit = commit_starter(Path::new("fixtures/website"), root.path()).await?;
    let capability = bootstrap["token"]
        .as_str()
        .ok_or("Missing initialization capability")?;
    let remote = bootstrap["remote"]
        .as_str()
        .ok_or("Missing Artifacts remote")?;
    let result = Command::new("git")
        .current_dir(root.path())
        .args(["push", remote, "HEAD:refs/heads/main"])
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.extraHeader")
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("Authorization: Bearer {capability}"),
        )
        .status()
        .await;
    let revoke = api_authenticated(
        url,
        "bootstrap",
        Some(json!({"name":name,"revoke_token_id":bootstrap["token_id"]})),
        secret,
    )
    .await;
    if !result?.success() {
        return Err("Starter push failed".into());
    }
    revoke?;
    let readback = api_authenticated(url, "bootstrap", Some(json!({"name":name})), secret).await?;
    if readback["commit"] != commit.as_str() {
        return Err("Starter Git readback mismatch".into());
    }
    println!("Website starter is ready: {commit}. New projects fork it without CLI setup.");
    Ok(())
}

/// Commits the trusted starter fixture as one root commit with a fixed identity and date,
/// so the same fixture always yields the same commit. Ignores the host's Git config.
async fn commit_starter(fixture: &Path, root: &Path) -> Result<String> {
    copy_regular_files(fixture, root)?;
    git(root, &["init", "-q", "-b", "main"]).await?;
    git(root, &["add", "--force", "--all"]).await?;
    let tree = git(root, &["write-tree"]).await?;
    let commit = git(
        root,
        &[
            "commit-tree",
            &tree,
            "-m",
            "Initialize static website starter",
        ],
    )
    .await?;
    git(root, &["update-ref", "refs/heads/main", &commit]).await?;
    Ok(commit)
}
fn copy_regular_files(from: &Path, to: &Path) -> Result<()> {
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            std::fs::create_dir_all(&target)?;
            copy_regular_files(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target)?;
        } else {
            return Err(format!("{} is not a regular file", entry.path().display()).into());
        }
    }
    Ok(())
}
async fn git(root: &Path, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "YonedaRepo capture")
        .env("GIT_AUTHOR_EMAIL", "capture@yoneda.invalid")
        .env("GIT_COMMITTER_NAME", "YonedaRepo capture")
        .env("GIT_COMMITTER_EMAIL", "capture@yoneda.invalid")
        .env("GIT_AUTHOR_DATE", "2026-10-07T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-10-07T00:00:00Z")
        .output()
        .await?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn the_starter_commit_is_deterministic() {
        let fixture =
            std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/website"));
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let first = super::commit_starter(fixture, a.path()).await.unwrap();
        assert_eq!(first.len(), 40);
        assert_eq!(
            first,
            super::commit_starter(fixture, b.path()).await.unwrap()
        );
    }
}
