//! `yoneda repo import <dir>`: a new repository from the files at HEAD of a local Git
//! repository (or every regular file of a plain directory). Up to one batch travels with
//! the create request; larger trees continue as chained commits landed once at the end,
//! so main moves from the first batch straight to the whole tree.
use crate::api::Api;
use crate::error::{Context, Error, Result};
use crate::git::Git;
use base64::Engine;
use serde_json::{Value, json};
use std::path::Path;

/// Files per request (the platform takes up to 10 000 changes per commit).
pub const BATCH_FILES: usize = 10_000;
/// Encoded bytes per request (base64 content), well inside the 64 MiB body limit.
pub const BATCH_BYTES: usize = 48 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct File {
    pub path: String,
    pub data: Vec<u8>,
    pub executable: bool,
}

impl File {
    fn encoded_len(&self) -> usize {
        self.data.len().div_ceil(3) * 4 + self.path.len() + 64
    }

    pub fn json(&self) -> Value {
        let mut value = json!({
            "path": self.path,
            "content_b64": base64::engine::general_purpose::STANDARD.encode(&self.data),
        });
        if self.executable {
            value["executable"] = json!(true);
        }
        value
    }
}

/// Splits `files` into ordered batches of at most `max_files` and about `max_bytes`
/// (a single larger file travels alone).
pub fn batches(files: Vec<File>, max_files: usize, max_bytes: usize) -> Vec<Vec<File>> {
    let mut out: Vec<Vec<File>> = Vec::new();
    let mut current = Vec::new();
    let mut bytes = 0;
    for file in files {
        let size = file.encoded_len();
        if !current.is_empty() && (current.len() >= max_files || bytes + size > max_bytes) {
            out.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes += size;
        current.push(file);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// The files to import from `dir`: HEAD's tree when `dir` is in a Git work tree (the
/// subtree under `dir`), else every regular file below it (`.git` aside).
pub fn files_of(dir: &Path) -> Result<Vec<File>> {
    let git = Git::new(dir);
    let mut files = if git.succeeds(&["rev-parse", "--verify", "-q", "HEAD"]) {
        from_head(&git)?
    } else {
        let mut found = Vec::new();
        walk(dir, dir, &mut found)?;
        found
    };
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn from_head(git: &Git) -> Result<Vec<File>> {
    let listed = git.output(&["ls-tree", "-r", "-z", "HEAD"], None, &[])?;
    let mut entries = Vec::new();
    for record in listed.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let record = String::from_utf8(record.to_vec())
            .map_err(|_| Error::new("a path at HEAD is not UTF-8; rename it to import"))?;
        let (meta, path) = record
            .split_once('\t')
            .ok_or_else(|| Error::new(format!("unexpected git ls-tree record {record:?}")))?;
        let parts: Vec<&str> = meta.split(' ').collect();
        match parts[..] {
            [mode @ ("100644" | "100755"), "blob", id] => {
                entries.push((path.to_owned(), id.to_owned(), mode == "100755"));
            }
            _ => eprintln!("yoneda: skipping {path} (not a regular file)"),
        }
    }
    let ids: Vec<String> = entries.iter().map(|(_, id, _)| id.clone()).collect();
    let mut blobs = git.read_blobs(&ids)?;
    entries
        .into_iter()
        .map(|(path, id, executable)| {
            let data = blobs
                .remove(&id)
                .or_else(|| git.read_blobs(std::slice::from_ref(&id)).ok()?.remove(&id))
                .ok_or_else(|| Error::new(format!("{path} is not readable")))?;
            Ok(File {
                path,
                data,
                executable,
            })
        })
        .collect()
}

fn walk(root: &Path, dir: &Path, found: &mut Vec<File>) -> Result<()> {
    let entries = std::fs::read_dir(dir).context(format!("reading {}", dir.display()))?;
    for entry in entries {
        let entry = entry.context(format!("reading {}", dir.display()))?;
        let path = entry.path();
        let kind = entry
            .file_type()
            .context(format!("reading {}", path.display()))?;
        if entry.file_name() == ".git" {
            continue;
        }
        if kind.is_dir() {
            walk(root, &path, found)?;
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .map(|p| p.replace(std::path::MAIN_SEPARATOR, "/"));
        let Some(relative) = relative.filter(|_| kind.is_file()) else {
            eprintln!(
                "yoneda: skipping {} (not a regular UTF-8 file)",
                path.display()
            );
            continue;
        };
        #[cfg(unix)]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            entry
                .metadata()
                .is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
        };
        #[cfg(not(unix))]
        let executable = false;
        found.push(File {
            path: relative,
            data: std::fs::read(&path).context(format!("reading {}", path.display()))?,
            executable,
        });
    }
    Ok(())
}

fn author(dir: &Path) -> Value {
    let git = Git::new(dir);
    let get = |key: &str| {
        git.run(&["config", "--get", key])
            .ok()
            .filter(|v| !v.is_empty())
    };
    json!({
        "name": get("user.name").unwrap_or_else(|| "yoneda-cli".into()),
        "email": get("user.email").unwrap_or_else(|| "cli@yonedarepo.invalid".into()),
    })
}

/// Creates repository `name` from `dir`; returns its id.
pub async fn import(
    origin: &str,
    account: &Api,
    token: &crate::credentials::Token,
    dir: &Path,
    name: &str,
    batch_files: usize,
) -> Result<String> {
    let files = files_of(dir)?;
    let total = files.len();
    let mut parts = batches(files, batch_files, BATCH_BYTES).into_iter();
    let first: Vec<Value> = parts
        .next()
        .unwrap_or_default()
        .iter()
        .map(File::json)
        .collect();
    let who = author(dir);
    let mut body = json!({ "name": name, "policy": crate::account::SOLO_POLICY.clone() });
    if !first.is_empty() {
        body["files"] = json!(first);
        body["author"] = who.clone();
        body["message"] = json!(format!("Import {name}"));
    }
    let created = account.post("/repos", &body).await?;
    let id = created["id"]
        .as_str()
        .ok_or_else(|| Error::new("the platform returned no repository id"))?
        .to_owned();
    let rest: Vec<Vec<File>> = parts.collect();
    if !rest.is_empty() {
        let repo = Api::new(origin, &id, token)?;
        let (version, mut parent) = repo.branch_at_latest("main").await?;
        let count = rest.len() + 1;
        for (index, part) in rest.iter().enumerate() {
            let changes = part.iter().map(File::json).collect();
            let message = format!("Import {name} (part {} of {count})", index + 2);
            parent = repo
                .create_commit(&parent, version, changes, &message, &who)
                .await
                .map_err(|f| Error::new(format!("importing part {}: {f}", index + 2)))?
                .commit;
        }
        repo.land("main", &parent)
            .await
            .map_err(|f| Error::new(format!("landing the import on main: {f}")))?;
    }
    println!("Imported {total} file(s) into {name} ({id})");
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::Repo;

    fn file(path: &str, len: usize) -> File {
        File {
            path: path.into(),
            data: vec![b'x'; len],
            executable: false,
        }
    }

    #[test]
    fn batches_by_count_and_size_in_order() {
        let files: Vec<File> = (0..7).map(|i| file(&format!("f{i}"), 1)).collect();
        let sizes: Vec<usize> = batches(files, 3, BATCH_BYTES)
            .iter()
            .map(Vec::len)
            .collect();
        assert_eq!(sizes, [3, 3, 1]);
        let big = vec![file("a", 10), file("b", 300), file("c", 10)];
        let split = batches(big, 100, 300);
        let paths: Vec<Vec<&str>> = split
            .iter()
            .map(|b| b.iter().map(|f| f.path.as_str()).collect())
            .collect();
        assert_eq!(paths, [vec!["a"], vec!["b"], vec!["c"]]);
        assert!(batches(Vec::new(), 3, 10).is_empty());
    }

    #[test]
    fn reads_head_not_the_work_tree_and_plain_directories() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("a.txt", b"a\n")?;
        repo.write("dir/run.sh", b"#!/bin/sh\n")?;
        #[cfg(unix)]
        repo.chmod("dir/run.sh", 0o755)?;
        repo.commit("base")?;
        repo.write("uncommitted.txt", b"no\n")?;
        let files = files_of(repo.root())?;
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "dir/run.sh"]);
        #[cfg(unix)]
        assert!(files[1].executable && files[1].json()["executable"] == true);

        let plain = tempfile::tempdir().context("tempdir")?;
        std::fs::create_dir_all(plain.path().join("x/.git")).context("mkdir")?;
        std::fs::write(plain.path().join("x/.git/HEAD"), b"ref").context("write")?;
        std::fs::write(plain.path().join("x/b.txt"), b"b").context("write")?;
        let files = files_of(plain.path())?;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "x/b.txt");
        Ok(())
    }
}
