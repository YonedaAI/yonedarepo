//! `.yoneda/state.json`: what this checkout is pinned to on the platform. Offline work is
//! one long optimistic transaction on `base_version`; the map ties local commits to the
//! platform commits made from them.
use crate::error::{Context, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const DIR: &str = ".yoneda";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub repo: String,
    pub origin: String,
    /// The platform branch work lands on.
    pub branch: String,
    /// Log version the pending local commits are based on.
    pub base_version: u64,
    /// The platform's Git commit of `branch` at `base_version`.
    pub base_commit: String,
    /// The local commit whose tree is `base_commit`'s (the same id after a `git clone`).
    pub local_base: String,
    /// This checkout's working branch on the platform: every pushed commit moves it by
    /// compare-and-swap, so a retry finds commits whose acknowledgment was lost.
    pub offline_branch: String,
    /// Where this checkout last saw `offline_branch` (`None`: not created yet).
    #[serde(default)]
    pub offline_head: Option<String>,
    /// Local commit → platform commit holding the same tree.
    #[serde(default)]
    pub platform: BTreeMap<String, String>,
    /// Every platform commit pushed on the current base, in order (a large local commit
    /// is several): what landing walks, and what a resumed sync must not push again.
    #[serde(default)]
    pub series: Vec<Pushed>,
    #[serde(default)]
    pub last_land: Option<Landed>,
    /// Remote MCP attempts: attempt id → last local commit committed through it.
    #[serde(default)]
    pub attempts: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pushed {
    pub commit: String,
    pub tree: String,
    pub parent: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Landed {
    pub version: u64,
    /// The landing's Git commit on the branch, once projected (`None` until then).
    pub git_commit: Option<String>,
}

impl State {
    pub fn path(root: &Path) -> PathBuf {
        root.join(DIR).join("state.json")
    }

    pub fn load(root: &Path) -> Result<Self> {
        let path = Self::path(root);
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(Error::new(format!(
                    "{} is not a yoneda checkout (no {}); use `yoneda clone`",
                    root.display(),
                    path.display()
                )));
            }
            Err(e) => return Err(Error::new(format!("reading {}: {e}", path.display()))),
        };
        serde_json::from_slice(&raw).context(format!("parsing {}", path.display()))
    }

    /// Writes atomically (temp file, fsync, rename): a crash leaves the old or new state.
    pub fn save(&self, root: &Path) -> Result<()> {
        let path = Self::path(root);
        let dir = root.join(DIR);
        std::fs::create_dir_all(&dir).context(format!("creating {}", dir.display()))?;
        let body = serde_json::to_vec_pretty(self).context("encoding state")?;
        let staging = dir.join("state.json.tmp");
        {
            use std::io::Write;
            let mut file = std::fs::File::create(&staging)
                .context(format!("writing {}", staging.display()))?;
            file.write_all(&body)
                .and_then(|()| file.sync_all())
                .context(format!("writing {}", staging.display()))?;
        }
        std::fs::rename(&staging, &path).context(format!("replacing {}", path.display()))
    }

    /// Re-pins the checkout on a new base; commits mapped on the old one no longer apply.
    pub fn rebase(&mut self, version: u64, platform_commit: &str, local: &str) {
        self.base_version = version;
        self.base_commit = platform_commit.to_owned();
        self.local_base = local.to_owned();
        self.platform.clear();
        self.series.clear();
    }
}

/// Keeps `.yoneda/` out of Git without touching the tracked `.gitignore`.
pub fn exclude(git_dir: &Path) -> Result<()> {
    let path = git_dir.join("info").join("exclude");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|l| l.trim() == "/.yoneda/") {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context(format!("creating {}", parent.display()))?;
    }
    let separator = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    std::fs::write(&path, format!("{current}{separator}/.yoneda/\n"))
        .context(format!("writing {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> State {
        State {
            repo: "r0123456789abcdef0123".into(),
            origin: "https://example.dev".into(),
            branch: "main".into(),
            base_version: 7,
            base_commit: "a".repeat(40),
            local_base: "b".repeat(40),
            offline_branch: "offline/0123abcd".into(),
            offline_head: Some("c".repeat(40)),
            platform: BTreeMap::from([("d".repeat(40), "e".repeat(40))]),
            series: vec![Pushed {
                commit: "e".repeat(40),
                tree: "f".repeat(40),
                parent: "a".repeat(40),
            }],
            last_land: Some(Landed {
                version: 9,
                git_commit: None,
            }),
            attempts: BTreeMap::new(),
        }
    }

    #[test]
    fn round_trips_through_the_state_file() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let state = sample();
        state.save(dir.path())?;
        assert_eq!(State::load(dir.path())?, state);
        assert!(!dir.path().join(DIR).join("state.json.tmp").exists());
        Ok(())
    }

    #[test]
    fn reads_a_minimal_state_and_explains_a_missing_one() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let refused = State::load(dir.path()).err().map(|e| e.message);
        assert!(refused.is_some_and(|m| m.contains("yoneda clone")));
        std::fs::create_dir_all(dir.path().join(DIR)).context("mkdir")?;
        let minimal = r#"{"repo":"r","origin":"o","branch":"main","base_version":1,
            "base_commit":"x","local_base":"y","offline_branch":"offline/z"}"#;
        std::fs::write(State::path(dir.path()), minimal).context("write")?;
        let loaded = State::load(dir.path())?;
        assert!(
            loaded.platform.is_empty() && loaded.series.is_empty() && loaded.offline_head.is_none()
        );
        Ok(())
    }

    #[test]
    fn excludes_the_state_directory_once() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        exclude(dir.path())?;
        exclude(dir.path())?;
        let text = std::fs::read_to_string(dir.path().join("info/exclude")).context("read")?;
        assert_eq!(text, "/.yoneda/\n");
        Ok(())
    }
}
