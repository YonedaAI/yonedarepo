//! Unit-test helpers: throwaway local Git repositories.
use crate::error::{Context, Result};
use crate::git::Git;
use std::path::Path;

pub struct Repo {
    pub dir: tempfile::TempDir,
    pub git: Git,
}

impl Repo {
    pub fn new() -> Result<Self> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let git = Git::new(dir.path());
        git.run(&["init", "-q", "-b", "main"])?;
        git.run(&["config", "user.name", "Tester"])?;
        git.run(&["config", "user.email", "tester@example.com"])?;
        git.run(&["config", "commit.gpgsign", "false"])?;
        Ok(Self { dir, git })
    }

    pub fn path(&self, rel: &str) -> std::path::PathBuf {
        self.dir.path().join(rel)
    }

    pub fn write(&self, rel: &str, data: &[u8]) -> Result<()> {
        let path = self.path(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("mkdir")?;
        }
        std::fs::write(&path, data).context(format!("writing {rel}"))
    }

    #[cfg(unix)]
    pub fn chmod(&self, rel: &str, mode: u32) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(self.path(rel), std::fs::Permissions::from_mode(mode))
            .context("chmod")
    }

    /// Stages everything and commits; returns the commit id.
    pub fn commit(&self, message: &str) -> Result<String> {
        self.git.run(&["add", "-A"])?;
        self.git
            .run(&["commit", "-q", "--allow-empty", "-m", message])?;
        self.git.run(&["rev-parse", "HEAD"])
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }
}
