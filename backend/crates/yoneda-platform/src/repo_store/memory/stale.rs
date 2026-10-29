//! Whether the code a memory is anchored to has changed on a branch since the memory was
//! written, read from the log (`txlog_paths` and the entries' per-path blobs):
//! - a file anchor is stale once the file's newest blob on the branch differs from the
//!   blob it was anchored to (deleted counts as changed);
//! - a symbol anchor is stale only when a change since then touched that symbol: walking
//!   the file's entries newest first back to the one that left or started from the
//!   anchored blob, an entry whose commit's derived symbol writes (`commit_symbols`) name
//!   it, or that has none (a whole-file write), makes it stale;
//! - a directory anchor, an anchor without a blob, a file whose history the log no longer
//!   holds (compacted, or moved without path detail since), and a symbol whose anchored
//!   blob the window never reaches are unknown (`None`).
//!
//! Each read is bounded: at most `WINDOW` entries per file and `BUDGET` entries in all.
use super::anchors::Anchor;
use crate::storage::SqlStore;
use serde_json::json;
use std::collections::HashMap;
use yoneda_core::Result;
use yoneda_core::txlog::TxEntry;

const WINDOW: u64 = 20;
const BUDGET: usize = 200;

/// A file's change on the branch at one log version.
#[derive(Clone)]
struct Change {
    old_blob: Option<String>,
    new_blob: Option<String>,
    commit: Option<String>,
}

pub struct Staleness<'a, S> {
    db: &'a S,
    refname: String,
    at: u64,
    /// Versions touching each path (newest first) and the newest move without path detail.
    versions: HashMap<String, Vec<u64>>,
    blank: Option<Option<u64>>,
    changes: HashMap<(u64, String), Option<Change>>,
    read: usize,
}

impl<'a, S: SqlStore> Staleness<'a, S> {
    pub fn new(db: &'a S, refname: &str, at: u64) -> Self {
        Self {
            db,
            refname: refname.to_owned(),
            at,
            versions: HashMap::new(),
            blank: None,
            changes: HashMap::new(),
            read: 0,
        }
    }

    fn versions(&mut self, path: &str) -> Result<Vec<u64>> {
        if let Some(found) = self.versions.get(path) {
            return Ok(found.clone());
        }
        let found: Vec<u64> = self
            .db
            .query(
                "SELECT version FROM txlog_paths WHERE refname=? AND path=? AND version<=? \
                 ORDER BY version DESC LIMIT ?",
                &[
                    json!(self.refname),
                    json!(path),
                    json!(self.at),
                    json!(WINDOW),
                ],
            )?
            .iter()
            .filter_map(|r| r["version"].as_u64())
            .collect();
        self.versions.insert(path.to_owned(), found.clone());
        Ok(found)
    }

    /// The newest entry that moved the branch without path detail (a reset or an import).
    fn blank(&mut self) -> Result<Option<u64>> {
        if let Some(found) = self.blank {
            return Ok(found);
        }
        let found = self.versions("")?.first().copied();
        self.blank = Some(found);
        Ok(found)
    }

    /// The file's change at `version`, or `None` when the entry is no longer retained or
    /// the read budget is spent.
    fn change(&mut self, version: u64, path: &str) -> Result<Option<Change>> {
        let key = (version, path.to_owned());
        if let Some(found) = self.changes.get(&key) {
            return Ok(found.clone());
        }
        if self.read >= BUDGET {
            return Ok(None);
        }
        self.read += 1;
        let row = self
            .db
            .query("SELECT entry FROM txlog WHERE version=?", &[json!(version)])?;
        let entry: Option<TxEntry> = row
            .first()
            .and_then(|r| serde_json::from_str(r["entry"].as_str().unwrap_or_default()).ok());
        let found = entry.and_then(|e| {
            e.paths.iter().find(|t| t.path == path).map(|t| Change {
                old_blob: t.old_blob.map(|b| b.hex()),
                new_blob: t.new_blob.map(|b| b.hex()),
                commit: e.new.map(|c| c.hex()),
            })
        });
        self.changes.insert(key, found.clone());
        Ok(found)
    }

    fn touched_symbol(&self, commit: Option<&str>, path: &str, symbol: &str) -> Result<bool> {
        let Some(commit) = commit else {
            return Ok(true);
        };
        let row = self.db.query(
            "SELECT symbols FROM commit_symbols WHERE commit_id=? AND path=?",
            &[json!(commit), json!(path)],
        )?;
        // No derived symbol writes: the whole file was written.
        let Some(symbols) = row.first().and_then(|r| r["symbols"].as_str()) else {
            return Ok(true);
        };
        let symbols: Vec<String> = serde_json::from_str(symbols).unwrap_or_default();
        Ok(symbols.is_empty() || symbols.iter().any(|s| s == symbol))
    }

    /// Whether `anchor`, written at log version `since`, is stale (`None`: unknown).
    pub fn anchor(&mut self, anchor: &Anchor, since: u64) -> Result<Option<bool>> {
        let Some(blob) = anchor.blob.as_deref().filter(|_| !anchor.is_dir()) else {
            return Ok(None);
        };
        let versions = self.versions(&anchor.path)?;
        let newest = versions.first().copied();
        // A reset or import since the memory (and the file's last change) hides its state.
        if let Some(blank) = self.blank()?
            && blank > since
            && newest.is_none_or(|v| blank > v)
        {
            return Ok(None);
        }
        let Some(newest) = newest else {
            // The branch never changed the file in the retained log.
            return Ok(Some(false));
        };
        let Some(latest) = self.change(newest, &anchor.path)? else {
            return Ok(None);
        };
        if latest.new_blob.as_deref() == Some(blob) {
            return Ok(Some(false));
        }
        if anchor.symbol_path.is_empty() {
            return Ok(Some(true));
        }
        for version in versions {
            let Some(change) = self.change(version, &anchor.path)? else {
                return Ok(None);
            };
            if change.new_blob.as_deref() == Some(blob) {
                return Ok(Some(false));
            }
            if change.new_blob.is_none()
                || self.touched_symbol(
                    change.commit.as_deref(),
                    &anchor.path,
                    &anchor.symbol_path,
                )?
            {
                return Ok(Some(true));
            }
            // This change started from the anchored file and left the symbol alone.
            if change.old_blob.as_deref() == Some(blob) {
                return Ok(Some(false));
            }
        }
        Ok(None)
    }
}
