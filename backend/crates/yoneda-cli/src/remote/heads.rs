//! Main's heads this clone has seen, with the log version at which each was main's head.
//! A pushed commit built on one of them is pinned to that version (its base version), so
//! landing checks it against exactly the changes that landed since (an unknown base
//! counts from version 0: every later change is checked, which is safe but merges more).
//!
//! Stored per repository in `$GIT_DIR/yoneda/<repo>.heads`, one `commit version` line per
//! head, appended (the highest version wins).
use crate::error::{Context, Error, Result};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct MainHeads {
    path: PathBuf,
    versions: HashMap<String, u64>,
}

impl MainHeads {
    pub fn open(git_dir: &Path, repo: &str) -> Result<Self> {
        let path = git_dir.join("yoneda").join(format!("{repo}.heads"));
        let mut heads = Self {
            path,
            versions: HashMap::new(),
        };
        let text = match std::fs::read_to_string(&heads.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(heads),
            Err(e) => return Err(Error::new(format!("reading {}: {e}", heads.path.display()))),
        };
        for line in text.lines() {
            // A torn last line (a crash mid-append) is skipped, never trusted.
            if let Some((commit, version)) = line.split_once(' ')
                && commit.len() == 40
                && let Ok(version) = version.parse()
            {
                heads.insert(commit, version);
            }
        }
        Ok(heads)
    }

    fn insert(&mut self, commit: &str, version: u64) {
        let entry = self.versions.entry(commit.to_owned()).or_default();
        *entry = (*entry).max(version);
    }

    /// Records that `commit` was main's head at `version` (durably, once).
    pub fn record(&mut self, commit: &str, version: u64) -> Result<()> {
        if self.version(commit) >= version {
            return Ok(());
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).context(format!("creating {}", dir.display()))?;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .context(format!("opening {}", self.path.display()))?;
        file.write_all(format!("{commit} {version}\n").as_bytes())
            .and_then(|()| file.sync_all())
            .context(format!("writing {}", self.path.display()))?;
        self.insert(commit, version);
        Ok(())
    }

    /// The version at which `commit` was main's head (0 when this clone never saw it).
    pub fn version(&self, commit: &str) -> u64 {
        self.versions.get(commit).copied().unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_version_of_each_head_across_reloads() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let repo = "r0123456789abcdef0123";
        let (a, b) = ("a".repeat(40), "b".repeat(40));
        let mut heads = MainHeads::open(dir.path(), repo)?;
        heads.record(&a, 3)?;
        heads.record(&a, 2)?;
        heads.record(&b, 5)?;
        let path = dir.path().join("yoneda").join(format!("{repo}.heads"));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .context("open")?;
        file.write_all(b"cccc").context("write")?;
        let heads = MainHeads::open(dir.path(), repo)?;
        assert_eq!((heads.version(&a), heads.version(&b)), (3, 5));
        assert_eq!(heads.version(&"c".repeat(40)), 0);
        Ok(())
    }
}
