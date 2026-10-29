//! Real Git as the oracle where the semantics are Git's: it unpacks every object the
//! platform built (hashing each itself), accepts them under `fsck --strict`, and answers
//! each ref's commit graph and files and each pair of branches' merge bases. Without a
//! `git` binary the check is skipped.
use super::Driver;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use yoneda_core::git_object::write_pack;
use yoneda_refmodel::Tree;

type Checked = std::result::Result<(), String>;

/// A throwaway bare repository, removed when dropped.
struct Bare(PathBuf);

impl Drop for Bare {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs git in `dir` with no user or system configuration, feeding `input`.
fn git(dir: &Path, args: &[&str], input: &[u8]) -> std::result::Result<Vec<u8>, String> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("HOME", dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git {args:?}: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no stdin")?
        .write_all(input)
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {args:?} failed: {stderr}"));
    }
    Ok(out.stdout)
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).into_owned()
}

pub(super) fn check(driver: &Driver) -> Checked {
    if Command::new("git").arg("--version").output().is_err() {
        eprintln!("SKIP: git not found");
        return Ok(());
    }
    let unique = format!("yoneda-diff-{}-{:p}", std::process::id(), driver);
    let bare = Bare(std::env::temp_dir().join(unique));
    std::fs::create_dir_all(&bare.0).map_err(|e| e.to_string())?;
    let dir = bare.0.as_path();
    git(dir, &["init", "-q", "--bare", "."], b"")?;
    let objects = driver.h.objects.borrow();
    let listed: Vec<_> = objects
        .values()
        .map(|(kind, data)| (*kind, data.as_slice()))
        .collect();
    let pack = write_pack(&listed).map_err(|e| e.message)?;
    git(dir, &["unpack-objects", "-q", "--strict"], &pack)?;
    for (name, id) in &driver.model.refs {
        git(dir, &["update-ref", name, &driver.ids[*id]], b"")?;
    }
    git(
        dir,
        &["fsck", "--strict", "--no-dangling", "--no-progress"],
        b"",
    )?;
    for (name, tip) in &driver.model.refs {
        same_history(driver, dir, name, *tip)?;
        same_files(dir, name, &driver.model.commits[*tip].tree)?;
    }
    same_merge_bases(driver, dir)
}

/// `git rev-list --parents` from `name` is the model's ancestry of `tip`, parents included.
fn same_history(driver: &Driver, dir: &Path, name: &str, tip: usize) -> Checked {
    let listed = text(git(dir, &["rev-list", "--parents", name], b"")?);
    let model: Vec<String> = driver
        .model
        .ancestry(tip)
        .into_iter()
        .map(|id| {
            let parent = driver.model.commits[id]
                .parent
                .map(|p| driver.ids[p].clone());
            [Some(driver.ids[id].clone()), parent]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect();
    let lines: Vec<&str> = listed.lines().collect();
    if lines != model {
        return Err(format!("history of {name}: git {lines:?}, model {model:?}"));
    }
    Ok(())
}

/// Git's files at `name` (`ls-tree -r`, contents through `cat-file --batch`) are `tree`.
fn same_files(dir: &Path, name: &str, tree: &Tree) -> Checked {
    let listed = text(git(dir, &["ls-tree", "-r", "--full-tree", name], b"")?);
    let mut blobs = Vec::new();
    for line in listed.lines() {
        let (meta, path) = line.split_once('\t').ok_or("ls-tree line without a tab")?;
        let id = meta.split(' ').nth(2).ok_or("ls-tree line without an id")?;
        blobs.push((path.to_owned(), id.to_owned()));
    }
    let ids: String = blobs.iter().map(|(_, id)| format!("{id}\n")).collect();
    let batch = git(dir, &["cat-file", "--batch"], ids.as_bytes())?;
    let mut files = Tree::new();
    let mut rest = batch.as_slice();
    for (path, _) in &blobs {
        let end = rest
            .iter()
            .position(|b| *b == b'\n')
            .ok_or("cat-file header")?;
        let header = String::from_utf8_lossy(&rest[..end]).into_owned();
        let size: usize = header
            .rsplit(' ')
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or("cat-file size")?;
        let content = &rest[end + 1..end + 1 + size];
        files.insert(path.clone(), String::from_utf8_lossy(content).into_owned());
        rest = &rest[end + 2 + size..];
    }
    if &files != tree {
        return Err(format!("files at {name}: git {files:?}, model {tree:?}"));
    }
    Ok(())
}

/// For each pair of refs, `git merge-base --all`, the model's and the authority's
/// `repo_merge_base` name the same commits.
fn same_merge_bases(driver: &Driver, dir: &Path) -> Checked {
    let refs: Vec<(&String, &usize)> = driver.model.refs.iter().collect();
    for (i, (left, l)) in refs.iter().enumerate() {
        for (right, r) in &refs[i + 1..] {
            let found = text(git(dir, &["merge-base", "--all", left, right], b"")?);
            let git_bases: BTreeSet<String> = found.lines().map(str::to_owned).collect();
            let model: BTreeSet<String> = driver
                .model
                .merge_bases(**l, **r)
                .into_iter()
                .map(|id| driver.ids[id].clone())
                .collect();
            let answered = driver.h.ok(
                super::OWNER,
                serde_json::json!({"op":"repo_merge_base","left":driver.ids[**l],"right":driver.ids[**r]}),
            );
            let platform: BTreeSet<String> = answered["merge_bases"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|b| b["commit"].as_str().map(str::to_owned))
                .collect();
            if git_bases != model || platform != model {
                let names: BTreeMap<&str, &BTreeSet<String>> = BTreeMap::from([
                    ("git", &git_bases),
                    ("model", &model),
                    ("platform", &platform),
                ]);
                return Err(format!("merge bases of {left} and {right}: {names:?}"));
            }
        }
    }
    Ok(())
}
