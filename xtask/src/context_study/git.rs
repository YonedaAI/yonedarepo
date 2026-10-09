use crate::process::Result;
use std::path::Path;
use tokio::process::Command;
pub(super) async fn git(root: &Path, grant: &str, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .current_dir(root)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "protocol.file.allow=never",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.extraHeader")
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("Authorization: Bearer {grant}"),
        )
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(120), command.output())
        .await
        .map_err(|_| "Study Git operation timed out")??;
    if !output.status.success() {
        return Err("Study Git operation failed; private stderr withheld".into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().into())
}
pub(super) async fn seed(root: &Path, grant: &str, remote: &str, base: &str) -> Result<String> {
    git(root, grant, &["clone", remote, "."]).await?;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    let workspace = yoneda_runtime::export_workspace(Path::new("fixtures/context-study/source"))?;
    let captured = yoneda_runtime::capture(
        root,
        Some(base),
        &workspace,
        "Seed synthetic context study fixture",
    )
    .await?;
    git(root, grant, &["push", remote, "HEAD:refs/heads/main"]).await?;
    Ok(captured["commit"].as_str().ok_or("No seed capture")?.into())
}
