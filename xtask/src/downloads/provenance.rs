//! Same-checkout receipts for immutable, same-run CLI build artifacts.
use super::package::{archive_name, sha256_hex, write};
use crate::process::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Receipt {
    pub schema: u8,
    pub revision: String,
    pub version: String,
    pub target: String,
    pub triple: String,
    pub archive: String,
    pub size: u64,
    pub sha256: String,
}

pub(super) fn verify_checkout(root: &Path, revision: &str) -> Result<()> {
    if revision.len() != 40
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Downloads require a full lowercase Git revision".into());
    }
    let head = Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(root)
        .output()?;
    if !head.status.success() || std::str::from_utf8(&head.stdout)?.trim() != revision {
        return Err("Downloads revision is not this checkout's HEAD".into());
    }
    let status = Command::new("git")
        .args(["status", "--porcelain", "-z", "--untracked-files=normal"])
        .current_dir(root)
        .output()?;
    if !status.status.success() || !status.stdout.is_empty() {
        return Err("Downloads require a clean checkout".into());
    }
    Ok(())
}

pub(super) fn regular(path: &Path) -> Result<()> {
    if !std::fs::symlink_metadata(path)?.file_type().is_file() {
        return Err("CLI artifact must be a regular, non-symlink file".into());
    }
    Ok(())
}

pub(super) fn write_receipt(
    staged: &Path,
    version: &str,
    target: &str,
    triple: &str,
    revision: &str,
) -> Result<()> {
    let archive = archive_name(version, target);
    let path = staged.join("cli").join(version).join(&archive);
    regular(&path)?;
    let bytes = std::fs::read(path)?;
    let receipt = Receipt {
        schema: 1,
        revision: revision.into(),
        version: version.into(),
        target: target.into(),
        triple: triple.into(),
        archive,
        size: u64::try_from(bytes.len())?,
        sha256: sha256_hex(&bytes),
    };
    write(
        &staged.join("receipt.json"),
        &serde_json::to_vec_pretty(&receipt)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_exact_head_and_no_tracked_or_untracked_changes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        std::fs::write(dir.path().join("tracked"), "fixture")?;
        for args in [
            vec!["init", "-q"],
            vec!["add", "tracked"],
            vec![
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
            ],
        ] {
            if !Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .status()?
                .success()
            {
                return Err("Fixture Git failed".into());
            }
        }
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(dir.path())
            .output()?;
        let revision = std::str::from_utf8(&output.stdout)?.trim();
        verify_checkout(dir.path(), revision)?;
        assert!(verify_checkout(dir.path(), &"b".repeat(40)).is_err());
        assert!(verify_checkout(dir.path(), "HEAD").is_err());
        std::fs::write(dir.path().join("untracked"), "fixture")?;
        assert!(verify_checkout(dir.path(), revision).is_err());
        std::fs::remove_file(dir.path().join("untracked"))?;
        std::fs::write(dir.path().join("tracked"), "changed")?;
        assert!(verify_checkout(dir.path(), revision).is_err());
        Ok(())
    }
}
