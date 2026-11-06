//! Where a clone's local service keeps its state: `.git/yoneda/local/` in the clone's
//! common Git directory, so every linked worktree of the clone finds the same service.
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use yoneda_core::{Error, Result};

pub fn local_error(message: impl Into<String>) -> Error {
    Error::new("LOCAL", message)
}

#[derive(Clone, Debug)]
pub struct Layout {
    pub dir: PathBuf,
}

/// What `init` fixed: the repository id and the loopback port, and the ids the repository
/// had before pairing gave it the cloud's (clones made earlier still use them).
#[derive(Clone, Debug)]
pub struct Config {
    pub repo: String,
    pub port: u16,
    pub aliases: Vec<String>,
}

impl Config {
    /// Whether `repo` (from a request path) names this repository: its id or an earlier one.
    pub fn serves(&self, repo: &str) -> bool {
        repo == self.repo || self.aliases.iter().any(|a| a == repo)
    }
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn url(&self) -> String {
        format!("{}/git/{}.git", self.origin(), self.repo)
    }
}

impl Layout {
    /// The layout of the clone (or worktree) at `cwd`.
    pub fn find(cwd: &Path) -> Result<Self> {
        let out = Command::new(crate::store::git_bin())
            .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
            .current_dir(cwd)
            .output()
            .map_err(|e| local_error(format!("Cannot run git: {e}")))?;
        if !out.status.success() {
            return Err(local_error("Not inside a Git repository"));
        }
        let common = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
        Ok(Self {
            dir: common.join("yoneda").join("local"),
        })
    }
    pub fn store(&self) -> PathBuf {
        self.dir.join("store.git")
    }
    pub fn authority(&self) -> PathBuf {
        self.dir.join("authority.sqlite")
    }
    pub fn sync(&self) -> PathBuf {
        self.dir.join("sync.json")
    }
    pub fn sync_token(&self) -> PathBuf {
        self.dir.join("sync-token")
    }
    /// The clone's common Git directory (`.git`), which holds this layout.
    pub fn common(&self) -> Option<PathBuf> {
        self.dir.parent()?.parent().map(Path::to_path_buf)
    }
    pub fn token(&self) -> PathBuf {
        self.dir.join("token")
    }
    pub fn lock(&self) -> PathBuf {
        self.dir.join("serve.lock")
    }
    pub fn pid(&self) -> PathBuf {
        self.dir.join("serve.pid")
    }
    fn config_path(&self) -> PathBuf {
        self.dir.join("local.json")
    }

    pub fn config(&self) -> Result<Config> {
        let text = std::fs::read_to_string(self.config_path())
            .map_err(|_| local_error("No local service here: run `yoneda local init` first"))?;
        let value: Value =
            serde_json::from_str(&text).map_err(|_| local_error("local.json is corrupt"))?;
        let repo = value["repo"].as_str().unwrap_or_default().to_owned();
        let port = value["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .ok_or_else(|| local_error("local.json has no port"))?;
        let aliases = value["aliases"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a.as_str().map(str::to_owned))
            .collect();
        Ok(Config {
            repo,
            port,
            aliases,
        })
    }

    pub fn write_config(&self, config: &Config) -> Result<()> {
        let text = json!({ "repo": config.repo, "port": config.port, "aliases": config.aliases })
            .to_string();
        write_private(&self.config_path(), text.as_bytes())
    }

    /// The token callers present (read only by the credential helper and the service).
    pub fn read_token(&self) -> Result<String> {
        let token = std::fs::read_to_string(self.token())
            .map_err(|_| local_error("The local token is missing"))?;
        Ok(token.trim().to_owned())
    }
}

/// Writes `bytes` to `path` readable by its owner only, through a renamed temporary file.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| local_error(format!("Cannot write {tmp:?}: {e}")))?;
    restrict(&tmp)?;
    std::fs::rename(&tmp, path).map_err(|e| local_error(format!("Cannot write {path:?}: {e}")))
}

#[cfg(unix)]
pub fn restrict(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| local_error(format!("Cannot restrict {path:?}: {e}")))
}

#[cfg(not(unix))]
pub fn restrict(_path: &Path) -> Result<()> {
    Ok(())
}
