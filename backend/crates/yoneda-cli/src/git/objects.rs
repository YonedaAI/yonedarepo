//! The local object database: reading objects, asking which are absent, adding packs.
//!
//! In a lazy (partial) clone Git fetches an absent object the moment something reads it.
//! The remote helper's own Git runs never do (`Git::in_helper`): asking whether an object
//! is held must not fetch it. Reading contents (`read_objects`) may: a push of a renamed
//! file the agent never opened needs that blob's bytes.
use super::Git;
use crate::error::{Context, Error, Result};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Stdio;
use yoneda_core::git_object::ObjectKind;

impl Git {
    /// Blob contents by id, through one `git cat-file --batch`.
    pub fn read_blobs(&self, ids: &[String]) -> Result<HashMap<String, Vec<u8>>> {
        self.read_objects(ids)?
            .into_iter()
            .map(|(id, (kind, data))| match kind {
                ObjectKind::Blob => Ok((id, data)),
                _ => Err(Error::new(format!(
                    "{id} is not a blob in the local repository"
                ))),
            })
            .collect()
    }

    /// Object kinds and contents by id, through one `git cat-file --batch` (absent objects
    /// are fetched first in a lazy clone).
    pub fn read_objects(&self, ids: &[String]) -> Result<HashMap<String, (ObjectKind, Vec<u8>)>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut child = self
            .command(&[])
            .env_remove("GIT_NO_LAZY_FETCH")
            .args(["cat-file", "--batch"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("running git cat-file")?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::new("git cat-file stdin"))?;
        let request = ids.iter().map(|id| format!("{id}\n")).collect::<String>();
        // A writer thread keeps a large request from deadlocking against the output.
        let writer = std::thread::spawn(move || stdin.write_all(request.as_bytes()));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::new("git cat-file stdout"))?;
        let mut reader = BufReader::new(stdout);
        let mut objects = HashMap::new();
        for id in ids {
            let mut header = String::new();
            reader
                .read_line(&mut header)
                .context("reading git cat-file")?;
            let (kind, size) = match header.split_whitespace().collect::<Vec<_>>()[..] {
                [_, kind, size] => (kind_named(kind), size.parse::<usize>().ok()),
                _ => (None, None),
            };
            let (Some(kind), Some(size)) = (kind, size) else {
                return Err(Error::new(format!("{id} is not in the local repository")));
            };
            let mut data = vec![0; size + 1];
            reader
                .read_exact(&mut data)
                .context("reading git cat-file")?;
            data.truncate(size);
            objects.insert(id.clone(), (kind, data));
        }
        writer
            .join()
            .map_err(|_| Error::new("git cat-file writer panicked"))?
            .context("writing to git cat-file")?;
        child.wait().context("waiting for git cat-file")?;
        Ok(objects)
    }

    /// The ids among `ids` that the local object database does not hold.
    pub fn missing(&self, ids: &[String]) -> Result<Vec<String>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let request = ids.iter().map(|id| format!("{id}\n")).collect::<String>();
        let out = self.output(
            &["cat-file", "--batch-check"],
            Some(request.as_bytes()),
            &[],
        )?;
        Ok(String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|line| line.strip_suffix(" missing").map(str::to_owned))
            .collect())
    }

    /// Adds a pack to the local object database (`git index-pack` verifies every
    /// object and writes the pack with its index).
    pub fn unpack(&self, pack: &[u8]) -> Result<()> {
        self.add_pack(pack, false)
    }

    /// Adds a pack; `promisor` marks it as fetched from the lazy clone's promisor remote,
    /// so Git accepts the objects it leaves out (blobs, trees outside a sparse scope) and
    /// fetches them when needed.
    pub fn add_pack(&self, pack: &[u8], promisor: bool) -> Result<()> {
        let args: &[&str] = if promisor {
            &["index-pack", "--stdin", "--promisor=yoneda"]
        } else {
            &["index-pack", "--stdin"]
        };
        self.output(args, Some(pack), &[]).map(|_| ())
    }
}

fn kind_named(name: &str) -> Option<ObjectKind> {
    Some(match name {
        "blob" => ObjectKind::Blob,
        "tree" => ObjectKind::Tree,
        "commit" => ObjectKind::Commit,
        "tag" => ObjectKind::Tag,
        _ => return None,
    })
}
