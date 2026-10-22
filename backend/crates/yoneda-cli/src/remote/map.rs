//! The commit map: the few local commits whose id differs from the platform commit they
//! stand for. A `yoneda::` clone otherwise holds the platform's commits byte for byte
//! (fetch writes their exact objects; push replays each local commit with its own author,
//! committer and message, so the platform builds the same object). Ids differ only when
//! the platform cannot reproduce or serve the exact object:
//! - a pushed commit split into parts (each part is a platform commit with its own tree),
//!   an empty commit (it maps to its parent), or one the platform cannot rebuild (a
//!   signature or `encoding` header, a message without its final newline);
//! - history the platform holds as tree and parents only (imported into the object
//!   store), which fetch converts into local commits (`convert`).
//!
//! Stored per repository in `$GIT_DIR/yoneda/<repo>.map`, one `server local` line per
//! entry, appended (a later line wins). Lines from older helpers carry a third field,
//! which is ignored.
use crate::error::{Context, Error, Result};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct CommitMap {
    path: PathBuf,
    by_server: HashMap<String, String>,
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
            let (server, local) = match parts[..] {
                [server, local] | [server, local, _] => (server, local),
                _ => continue,
            };
            if hex40(server) && hex40(local) {
                map.insert(server, local);
            }
        }
        Ok(map)
    }

    fn insert(&mut self, server: &str, local: &str) {
        self.by_server.insert(server.to_owned(), local.to_owned());
        self.by_local.insert(local.to_owned(), server.to_owned());
    }

    /// Records entries durably (appended, then synced). Pairs with equal ids need no
    /// entry and are skipped.
    pub fn record(&mut self, entries: &[(String, String)]) -> Result<()> {
        let entries: Vec<&(String, String)> = entries.iter().filter(|(s, l)| s != l).collect();
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
        let text: String = entries.iter().map(|(s, l)| format!("{s} {l}\n")).collect();
        file.write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .context(format!("writing {}", self.path.display()))?;
        for (server, local) in entries {
            self.insert(server, local);
        }
        Ok(())
    }

    /// The local commit standing for platform commit `server`, when their ids differ.
    pub fn local(&self, server: &str) -> Option<&str> {
        self.by_server.get(server).map(String::as_str)
    }

    /// The platform commit local commit `local` stands for, when their ids differ.
    pub fn server(&self, local: &str) -> Option<&str> {
        self.by_local.get(local).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(c: char) -> String {
        c.to_string().repeat(40)
    }

    #[test]
    fn records_only_differing_ids_durably_with_later_lines_winning() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let repo = "r0123456789abcdef0123";
        let mut map = CommitMap::open(dir.path(), repo)?;
        assert_eq!(map.local(&id('a')), None);
        map.record(&[(id('a'), id('1')), (id('b'), id('b'))])?;
        map.record(&[(id('c'), id('1'))])?;
        let path = dir.path().join("yoneda").join(format!("{repo}.map"));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .context("open")?;
        // An older helper's line (with a version) still loads; a torn line is ignored.
        file.write_all(format!("{} {} 7\ndddd 12", id('e'), id('2')).as_bytes())
            .context("write")?;

        let map = CommitMap::open(dir.path(), repo)?;
        assert_eq!(map.local(&id('a')), Some(id('1').as_str()));
        assert_eq!(map.local(&id('b')), None, "equal ids need no entry");
        assert_eq!(map.server(&id('1')), Some(id('c').as_str()));
        assert_eq!(map.local(&id('e')), Some(id('2').as_str()));
        Ok(())
    }
}
