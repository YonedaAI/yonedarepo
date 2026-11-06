//! The object store of record: a bare Git repository, driven with real Git. Objects are
//! written and fsynced (`core.fsync`) before the authority records them; refs here are a
//! projection of the authority's (`project`), moved only with an expected old value.
use crate::layout::local_error;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use yoneda_core::{
    Result,
    git_object::{ObjectId, ObjectKind, hash_object},
};

#[derive(Clone, Debug)]
pub struct Store {
    pub path: PathBuf,
}

/// Settings of the store: objects and refs durable before Git returns, nothing ever
/// pruned or repacked behind the service's back (the authority records commits by id and
/// expects them to stay), and the hidden refs server-built commits arrive under left out of
/// fetches. `gc.auto=0` alone does not stop Git: its default maintenance strategy is now
/// geometric repacking, which `receive-pack` starts after each push and which then races
/// the next push's quarantine ("unable to migrate objects to permanent storage", seen with
/// 8 simultaneous pushes).
const SETTINGS: [(&str, &str); 8] = [
    ("core.fsync", "objects,derived-metadata,reference"),
    ("core.fsyncMethod", "fsync"),
    ("gc.auto", "0"),
    ("receive.autogc", "false"),
    ("maintenance.auto", "false"),
    ("gc.pruneExpire", "never"),
    ("uploadpack.hideRefs", "refs/yoneda/"),
    ("receive.fsckObjects", "true"),
];

impl Store {
    pub fn at(path: &Path) -> Self {
        Self {
            path: path.to_owned(),
        }
    }

    pub fn create(path: &Path) -> Result<Self> {
        let parent = path.parent().unwrap_or(path);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("store.git");
        run_in(parent, &["init", "-q", "--bare", "-b", "main", name], None)?;
        let store = Self::at(path);
        store.configure()?;
        Ok(store)
    }

    /// Applies the store's settings (again: a store made by an older version gains new ones).
    pub fn configure(&self) -> Result<()> {
        for (key, value) in SETTINGS {
            self.git(&["config", key, value], None)?;
        }
        Ok(())
    }

    pub fn git(&self, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
        let mut full = vec!["--git-dir", self.path.to_str().unwrap_or_default()];
        full.extend_from_slice(args);
        run_in(&self.path, &full, stdin)
    }

    /// Objects by id (`None` for missing ones), through one `git cat-file --batch`.
    pub fn read(&self, ids: &[ObjectId]) -> Result<HashMap<ObjectId, (ObjectKind, Vec<u8>)>> {
        let input: String = ids.iter().map(|id| format!("{id}\n")).collect();
        let out = self.git(&["cat-file", "--batch"], Some(input.as_bytes()))?;
        let mut found = HashMap::new();
        let mut at = 0;
        while at < out.len() {
            let end = out[at..]
                .iter()
                .position(|b| *b == b'\n')
                .map(|p| at + p)
                .ok_or_else(|| local_error("Truncated cat-file answer"))?;
            let header = String::from_utf8_lossy(&out[at..end]).into_owned();
            at = end + 1;
            let parts: Vec<&str> = header.split(' ').collect();
            if parts.len() != 3 {
                continue;
            }
            let size: usize = parts[2]
                .parse()
                .map_err(|_| local_error("Bad object size"))?;
            let data = out
                .get(at..at + size)
                .ok_or_else(|| local_error("Truncated object"))?
                .to_vec();
            at += size + 1;
            let kind = kind_of(parts[1])?;
            found.insert(ObjectId::parse(parts[0])?, (kind, data));
        }
        Ok(found)
    }

    /// The ids among `ids` this store holds as `kind`.
    pub fn holds(&self, ids: &[ObjectId], kind: &str) -> Result<Vec<ObjectId>> {
        let input: String = ids.iter().map(|id| format!("{id}\n")).collect();
        let out = self.git(
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            Some(input.as_bytes()),
        )?;
        String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| l.split_once(' '))
            .filter(|(_, k)| *k == kind)
            .map(|(id, _)| ObjectId::parse(id))
            .collect()
    }

    /// Writes one object, checking Git agrees on its id.
    pub fn write(&self, kind: ObjectKind, data: &[u8]) -> Result<ObjectId> {
        let id = hash_object(kind, data);
        let out = self.git(
            &[
                "hash-object",
                "-w",
                "--literally",
                "-t",
                kind.name(),
                "--stdin",
            ],
            Some(data),
        )?;
        if String::from_utf8_lossy(&out).trim() != id.hex() {
            return Err(local_error("The store disagrees on an object's id"));
        }
        Ok(id)
    }

    /// Stores a complete pack (no thin deltas).
    pub fn index_pack(&self, pack: &[u8]) -> Result<()> {
        self.git(&["index-pack", "--stdin", "--strict"], Some(pack))
            .map(|_| ())
    }

    /// Runs a receive-pack request body as Git's own server does, answering its report.
    pub fn receive_pack(&self, body: &[u8]) -> Result<Vec<u8>> {
        let path = self.path.to_str().unwrap_or_default().to_owned();
        run_in(
            &self.path,
            &["receive-pack", "--stateless-rpc", &path],
            Some(body),
        )
    }

    /// Whether the store holds object `id`.
    pub fn has(&self, id: &ObjectId) -> bool {
        self.git(&["cat-file", "-e", &id.to_string()], None).is_ok()
    }

    /// Whether `ancestor` is `descendant` or one of its ancestors (both held).
    pub fn is_ancestor(&self, ancestor: &ObjectId, descendant: &ObjectId) -> bool {
        let (a, d) = (ancestor.to_string(), descendant.to_string());
        self.git(&["merge-base", "--is-ancestor", &a, &d], None)
            .is_ok()
    }

    /// Branches and tags as the store holds them.
    pub fn refs(&self) -> Result<HashMap<String, ObjectId>> {
        let out = self.git(
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads",
                "refs/tags",
            ],
            None,
        )?;
        String::from_utf8_lossy(&out)
            .lines()
            .filter_map(|l| l.split_once(' '))
            .map(|(name, id)| Ok((name.to_owned(), ObjectId::parse(id)?)))
            .collect()
    }

    /// Moves `name` to `new` (deletes it with `None`) only while it is at `old`.
    pub fn update_ref(
        &self,
        name: &str,
        new: Option<ObjectId>,
        old: Option<ObjectId>,
    ) -> Result<()> {
        let zero = "0".repeat(40);
        let old = old.map_or(zero.clone(), |id| id.hex());
        match new {
            Some(id) => self.git(&["update-ref", name, &id.hex(), &old], None),
            None => self.git(&["update-ref", "-d", name, &old], None),
        }
        .map(|_| ())
    }
}

fn kind_of(name: &str) -> Result<ObjectKind> {
    Ok(match name {
        "commit" => ObjectKind::Commit,
        "tree" => ObjectKind::Tree,
        "blob" => ObjectKind::Blob,
        "tag" => ObjectKind::Tag,
        other => return Err(local_error(format!("Unknown object type {other}"))),
    })
}

/// Runs `git args` in `cwd` with `stdin`, answering its output or its error text.
pub fn run_in(cwd: &Path, args: &[&str], stdin: Option<&[u8]>) -> Result<Vec<u8>> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| local_error(format!("Cannot run git: {e}")))?;
    let writer = stdin.map(|data| {
        let mut pipe = child.stdin.take();
        let data = data.to_vec();
        std::thread::spawn(move || {
            if let Some(pipe) = pipe.as_mut() {
                let _ = pipe.write_all(&data);
            }
        })
    });
    let out = child
        .wait_with_output()
        .map_err(|e| local_error(format!("git failed: {e}")))?;
    if let Some(writer) = writer {
        let _ = writer.join();
    }
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(local_error(format!(
            "git {} failed: {}",
            args.iter().find(|a| !a.starts_with('-')).unwrap_or(&""),
            err.trim()
        )));
    }
    Ok(out.stdout)
}
