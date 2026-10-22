//! The commit map: which local commit stands for which platform commit. The platform
//! records each pushed commit with its own committer and time, so its id differs from
//! the local one even though the tree is identical; and `/objects` serves commits as
//! tree plus parents only. The map lets Git see its own commits on the remote after a
//! push, and the platform's commits as stable local ones after a fetch.
//!
//! Stored per repository in `$GIT_DIR/yoneda/<repo>.map`, one `server local version`
//! line per entry, appended (a later line wins). `version` is the log version at which
//! the server commit was seen as main's head (0 otherwise).
use crate::error::{Context, Error, Result};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub local: String,
    pub version: u64,
}

pub struct CommitMap {
    path: PathBuf,
    by_server: HashMap<String, Entry>,
    by_local: HashMap<String, String>,
}

fn hex40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

impl CommitMap {
    /// Loads (or starts) the map of `repo` in the repository at `git_dir`.
    pub fn open(git_dir: &Path, repo: &str) -> Result<Self> {
        let path = git_dir.join("yoneda").join(format!("{repo}.map"));
        let mut map = Self {
            path,
            by_server: HashMap::new(),
            by_local: HashMap::new(),
        };
        let text = match std::fs::read_to_string(&map.path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(map),
            Err(e) => return Err(Error::new(format!("reading {}: {e}", map.path.display()))),
        };
        for line in text.lines() {
            let parts: Vec<&str> = line.split(' ').collect();
            // A torn last line (a crash mid-append) is skipped, never trusted.
            if let [server, local, version] = parts[..]
                && hex40(server)
                && hex40(local)
                && let Ok(version) = version.parse()
            {
                map.insert(server, local, version);
            }
        }
        Ok(map)
    }

    fn insert(&mut self, server: &str, local: &str, version: u64) {
        let version = match self.by_server.get(server) {
            Some(old) if old.local == local => old.version.max(version),
            _ => version,
        };
        self.by_server.insert(
            server.to_owned(),
            Entry {
                local: local.to_owned(),
                version,
            },
        );
        self.by_local.insert(local.to_owned(), server.to_owned());
    }

    /// Records entries durably (appended, then synced).
    pub fn record(&mut self, entries: &[(String, String, u64)]) -> Result<()> {
        if entries.is_empty() {
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
        let text: String = entries
            .iter()
            .map(|(s, l, v)| format!("{s} {l} {v}\n"))
            .collect();
        file.write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .context(format!("writing {}", self.path.display()))?;
        for (server, local, version) in entries {
            self.insert(server, local, *version);
        }
        Ok(())
    }

    pub fn local(&self, server: &str) -> Option<&str> {
        self.by_server.get(server).map(|e| e.local.as_str())
    }

    pub fn server(&self, local: &str) -> Option<&str> {
        self.by_local.get(local).map(String::as_str)
    }

    /// The log version at which `server` was main's head (0 when unknown).
    pub fn version(&self, server: &str) -> u64 {
        self.by_server.get(server).map_or(0, |e| e.version)
    }

    /// Main's heads this clone has seen, newest first: (server, local, version).
    pub fn main_heads(&self) -> Vec<(&str, &str, u64)> {
        let mut heads: Vec<(&str, &str, u64)> = self
            .by_server
            .iter()
            .filter(|(_, e)| e.version > 0)
            .map(|(s, e)| (s.as_str(), e.local.as_str(), e.version))
            .collect();
        heads.sort_by_key(|h| std::cmp::Reverse(h.2));
        heads
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(c: char) -> String {
        c.to_string().repeat(40)
    }

    #[test]
    fn records_durably_and_reloads_with_later_lines_winning() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let repo = "r0123456789abcdef0123";
        let mut map = CommitMap::open(dir.path(), repo)?;
        assert_eq!(map.local(&id('a')), None);
        map.record(&[(id('a'), id('1'), 0), (id('b'), id('2'), 5)])?;
        map.record(&[(id('c'), id('1'), 9), (id('a'), id('1'), 3)])?;
        let path = dir.path().join("yoneda").join(format!("{repo}.map"));
        // A torn line from a crash mid-append is ignored.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .context("open")?;
        file.write_all(b"dddd 12").context("write")?;

        let map = CommitMap::open(dir.path(), repo)?;
        assert_eq!(map.local(&id('a')), Some(id('1').as_str()));
        assert_eq!(map.version(&id('a')), 3);
        // The newest server commit for a local one is the one a push builds on.
        assert_eq!(map.server(&id('1')), Some(id('a').as_str()));
        let heads: Vec<u64> = map.main_heads().iter().map(|h| h.2).collect();
        assert_eq!(heads, [9, 5, 3]);
        Ok(())
    }
}
