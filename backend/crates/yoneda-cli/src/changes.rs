//! What a local commit changed against its first parent, in the platform's commit format:
//! whole-file writes (with the executable bit) and deletes. Renames travel as a delete
//! plus an add. Symlinks and submodules are refused: the platform takes regular files.
use crate::error::{Error, Result};
use crate::git::Git;
use base64::Engine;
use serde_json::{Value, json};
use yoneda_core::git_object::{FileMode, ObjectId, PathChange};

/// One path's change. `old_blob` is the parent's blob (the platform's `expect`
/// precondition), `None` when the path was absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub old_blob: Option<String>,
    pub target: Target,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Write {
        blob: String,
        executable: bool,
        data: Vec<u8>,
    },
    Delete,
}

impl Change {
    /// Bytes this change occupies in a JSON request (base64 content plus framing).
    pub fn encoded_len(&self) -> usize {
        let content = match &self.target {
            Target::Write { data, .. } => data.len().div_ceil(3) * 4,
            Target::Delete => 0,
        };
        content + self.path.len() + 128
    }

    pub fn content_len(&self) -> usize {
        match &self.target {
            Target::Write { data, .. } => data.len(),
            Target::Delete => 0,
        }
    }

    /// The platform API's change object (with the `expect` precondition).
    pub fn api_json(&self) -> Value {
        let mut value = self.mcp_json();
        value["expect"] = json!(self.old_blob);
        value
    }

    /// The remote MCP `attempt_commit` change object.
    pub fn mcp_json(&self) -> Value {
        match &self.target {
            Target::Delete => json!({ "path": self.path, "delete": true }),
            Target::Write {
                data, executable, ..
            } => json!({
                "path": self.path,
                "content_b64": base64::engine::general_purpose::STANDARD.encode(data),
                "executable": executable,
            }),
        }
    }

    /// This change as a tree edit (a delete has no target).
    pub fn path_change(&self) -> Result<PathChange> {
        let target = match &self.target {
            Target::Write {
                blob, executable, ..
            } => {
                let mode = if *executable {
                    FileMode::Executable
                } else {
                    FileMode::Blob
                };
                let id = ObjectId::parse(blob)
                    .map_err(|e| Error::new(format!("{}: {}", self.path, e.message)))?;
                Some((mode, id))
            }
            Target::Delete => None,
        };
        Ok(PathChange {
            path: self.path.clone(),
            target,
        })
    }
}

/// One record of `git diff-tree -r -z --raw`.
#[derive(Debug, PartialEq, Eq)]
pub struct RawEntry {
    pub old_mode: String,
    pub new_mode: String,
    pub old_blob: String,
    pub new_blob: String,
    pub path: String,
}

/// Parses `git diff-tree -r -z --no-renames --raw` output.
pub fn parse_raw(out: &[u8]) -> Result<Vec<RawEntry>> {
    let mut fields = out.split(|b| *b == 0).filter(|f| !f.is_empty());
    let mut entries = Vec::new();
    while let Some(meta) = fields.next() {
        let meta = String::from_utf8_lossy(meta);
        let path = fields
            .next()
            .ok_or_else(|| Error::new("truncated git diff-tree output"))?;
        let path = String::from_utf8(path.to_vec())
            .map_err(|_| Error::new("a changed path is not UTF-8; rename it to sync"))?;
        let parts: Vec<&str> = meta.trim_start_matches(':').split(' ').collect();
        let [old_mode, new_mode, old_blob, new_blob, _status] = parts[..] else {
            return Err(Error::new(format!(
                "unexpected git diff-tree record {meta:?}"
            )));
        };
        entries.push(RawEntry {
            old_mode: old_mode.into(),
            new_mode: new_mode.into(),
            old_blob: old_blob.into(),
            new_blob: new_blob.into(),
            path,
        });
    }
    Ok(entries)
}

/// Changes of `commit` against `parent`: deletes first (so a file can become a
/// directory within one request), then writes, each group in path order.
pub fn between(git: &Git, parent: &str, commit: &str) -> Result<Vec<Change>> {
    let out = git.output(
        &[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--no-commit-id",
            "--raw",
            parent,
            commit,
        ],
        None,
        &[],
    )?;
    let raw = parse_raw(&out)?;
    let wanted: Vec<String> = raw
        .iter()
        .filter(|e| e.new_mode != "000000")
        .map(|e| e.new_blob.clone())
        .collect();
    let mut contents = git.read_blobs(&wanted)?;
    let mut changes = raw
        .into_iter()
        .map(|entry| change_of(entry, &mut |id| contents.remove(id)))
        .collect::<Result<Vec<_>>>()?;
    changes.sort_by(|a, b| {
        let rank = |c: &Change| matches!(c.target, Target::Write { .. });
        (rank(a), &a.path).cmp(&(rank(b), &b.path))
    });
    Ok(changes)
}

/// One raw record as a change; `content` hands out a written blob's bytes.
pub fn change_of(
    entry: RawEntry,
    content: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
) -> Result<Change> {
    yoneda_core::validate_path(&entry.path)
        .map_err(|e| Error::new(format!("{:?} cannot be synced: {}", entry.path, e.message)))?;
    let old_blob = matches!(entry.old_mode.as_str(), "100644" | "100755" | "120000")
        .then(|| entry.old_blob.clone());
    let target = match entry.new_mode.as_str() {
        "000000" => Target::Delete,
        "100644" | "100755" => Target::Write {
            data: content(&entry.new_blob).ok_or_else(|| {
                Error::new(format!(
                    "{} (blob {}) is not readable locally",
                    entry.path, entry.new_blob
                ))
            })?,
            executable: entry.new_mode == "100755",
            blob: entry.new_blob,
        },
        "120000" => {
            return Err(Error::new(format!(
                "{} is a symlink; the platform stores regular files only. Replace it with a regular file (or remove it) and amend the commit",
                entry.path
            )));
        }
        "160000" => {
            return Err(Error::new(format!(
                "{} is a submodule; the platform stores regular files only. Vendor its files or remove it and amend the commit",
                entry.path
            )));
        }
        other => {
            return Err(Error::new(format!(
                "{} has unsupported mode {other}",
                entry.path
            )));
        }
    };
    Ok(Change {
        path: entry.path,
        old_blob,
        target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Repo;

    fn by_path<'a>(changes: &'a [Change], path: &str) -> Option<&'a Change> {
        changes.iter().find(|c| c.path == path)
    }

    #[test]
    fn computes_writes_deletes_exec_bits_binary_and_unicode_paths() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("keep.txt", b"keep\n")?;
        repo.write("old/name.txt", b"moved\n")?;
        repo.write("gone.txt", b"bye\n")?;
        repo.write("run.sh", b"#!/bin/sh\n")?;
        let parent = repo.commit("base")?;
        std::fs::remove_file(repo.path("gone.txt")).map_err(|e| Error::new(e.to_string()))?;
        std::fs::create_dir_all(repo.path("new"))
            .and_then(|()| std::fs::rename(repo.path("old/name.txt"), repo.path("new/name.txt")))
            .map_err(|e| Error::new(e.to_string()))?;
        repo.chmod("run.sh", 0o755)?;
        let binary: Vec<u8> = (0..=255u8).chain([0, 0, 255]).collect();
        repo.write("img/logo.bin", &binary)?;
        repo.write("docs/ünïcødé dir/naïve file.md", "héllo\n".as_bytes())?;
        let commit = repo.commit("work")?;

        let changes = between(&repo.git, &parent, &commit)?;
        // Deletes come first, each group in path order; the rename is a delete plus an add.
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "gone.txt",
                "old/name.txt",
                "docs/ünïcødé dir/naïve file.md",
                "img/logo.bin",
                "new/name.txt",
                "run.sh"
            ]
        );
        let gone = by_path(&changes, "gone.txt").ok_or_else(|| Error::new("gone"))?;
        assert_eq!(gone.target, Target::Delete);
        assert!(gone.old_blob.is_some());
        let run = by_path(&changes, "run.sh").ok_or_else(|| Error::new("run"))?;
        assert!(matches!(
            run.target,
            Target::Write {
                executable: true,
                ..
            }
        ));
        assert_eq!(run.old_blob.as_deref().map(str::len), Some(40));
        let logo = by_path(&changes, "img/logo.bin").ok_or_else(|| Error::new("logo"))?;
        assert!(
            matches!(&logo.target, Target::Write { data, executable: false, .. } if *data == binary)
        );
        assert_eq!(logo.old_blob, None);
        assert_eq!(logo.api_json()["expect"], Value::Null);
        assert_eq!(
            logo.api_json()["content_b64"].as_str().map(str::len),
            Some(348)
        );
        let moved = by_path(&changes, "new/name.txt").ok_or_else(|| Error::new("moved"))?;
        assert!(matches!(&moved.target, Target::Write { data, .. } if data == b"moved\n"));
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_and_submodules_with_a_way_out() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("a.txt", b"a\n")?;
        let parent = repo.commit("base")?;
        std::os::unix::fs::symlink("a.txt", repo.path("link"))
            .map_err(|e| Error::new(e.to_string()))?;
        let commit = repo.commit("link")?;
        let refused = between(&repo.git, &parent, &commit)
            .err()
            .map(|e| e.message);
        assert!(
            refused.is_some_and(|m| m.contains("link is a symlink") && m.contains("regular file"))
        );
        let gitlink = RawEntry {
            old_mode: "000000".into(),
            new_mode: "160000".into(),
            old_blob: "0".repeat(40),
            new_blob: "1".repeat(40),
            path: "vendor/lib".into(),
        };
        let refused = change_of(gitlink, &mut |_| None).err().map(|e| e.message);
        assert!(refused.is_some_and(|m| m.contains("submodule")));
        Ok(())
    }

    #[test]
    fn path_changes_rebuild_the_commit_tree() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("a.txt", b"a\n")?;
        repo.write("b/c.txt", b"c\n")?;
        let parent = repo.commit("base")?;
        repo.write("a.txt", b"A\n")?;
        std::fs::remove_file(repo.path("b/c.txt")).map_err(|e| Error::new(e.to_string()))?;
        repo.write("d/é.txt", b"d\n")?;
        let commit = repo.commit("work")?;
        let changes = between(&repo.git, &parent, &commit)?;
        let edits = changes
            .iter()
            .map(Change::path_change)
            .collect::<Result<Vec<_>>>()?;
        assert_eq!(
            crate::git::Trees::new(&repo.git).with(&parent, &edits)?,
            repo.git.tree_of(&commit)?
        );
        Ok(())
    }
}
