//! The runtime image's inputs hash (deploy_image): the blobs at the deployed revision of
//! what the Dockerfile copies into the shipped image: the Dockerfile and entrypoint,
//! `.dockerignore`, the root Cargo manifest, the pnpm manifests and lockfile, every local crate
//! `yoneda-runtime` builds from, and the `Cargo.lock` entries reachable from `yoneda-runtime`
//! (dev dependencies included). The other workspace members and their lock entries are copied
//! only so the in-image `cargo test` and workspace resolution work; they never reach the
//! shipped binary, so changing them (say, an xtask dependency) reuses the image.
use crate::process::Result;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

const INPUTS_VERSION: &str = "yoneda-runtime-inputs-v1";
const RUNTIME_CRATE: &str = "yoneda-runtime";
/// Repository paths the Dockerfile copies into the shipped image, besides the crates and
/// the runtime's share of `Cargo.lock` ([`runtime_lock`]).
pub(crate) const FIXED_INPUTS: [&str; 7] = [
    ".dockerignore",
    "Cargo.toml",
    "cloudflare/containers",
    "frontend/package.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
];

/// Repository-relative directories of the local crates `yoneda-runtime` builds from (normal
/// and build dependencies, transitively), from `cargo metadata --no-deps`.
pub(crate) fn runtime_crates(metadata: &Value) -> Result<Vec<String>> {
    let root = metadata["workspace_root"]
        .as_str()
        .ok_or("cargo metadata has no workspace_root")?;
    let packages = metadata["packages"]
        .as_array()
        .ok_or("cargo metadata has no packages")?;
    let dir_of = |package: &Value| {
        package["manifest_path"]
            .as_str()
            .and_then(|m| Path::new(m).parent())
            .map(Path::to_path_buf)
    };
    let by_dir: BTreeMap<_, _> = packages
        .iter()
        .filter_map(|p| Some((dir_of(p)?, p)))
        .collect();
    let start = packages
        .iter()
        .find(|p| p["name"] == RUNTIME_CRATE)
        .and_then(dir_of)
        .ok_or("cargo metadata does not list yoneda-runtime")?;
    let (mut seen, mut queue) = (BTreeSet::new(), vec![start]);
    while let Some(dir) = queue.pop() {
        if !seen.insert(dir.clone()) {
            continue;
        }
        let package = by_dir
            .get(&dir)
            .ok_or_else(|| format!("{} is not a workspace package", dir.display()))?;
        for dep in package["dependencies"].as_array().into_iter().flatten() {
            if let Some(path) = dep["path"].as_str()
                && dep["kind"].as_str() != Some("dev")
            {
                queue.push(path.into());
            }
        }
    }
    seen.iter()
        .map(|dir| {
            dir.strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("{} is outside the workspace", dir.display()).into())
        })
        .collect()
}

/// The fixed inputs plus the crate directories, sorted.
pub(crate) fn pathspecs(crates: &[String]) -> Vec<String> {
    let mut all: BTreeSet<String> = FIXED_INPUTS.iter().map(|p| (*p).to_owned()).collect();
    all.extend(crates.iter().cloned());
    all.into_iter().collect()
}

/// One `[[package]]` entry of `Cargo.lock`.
struct LockEntry<'a> {
    name: &'a str,
    version: &'a str,
    dependencies: Vec<&'a str>,
    text: Vec<&'a str>,
}

fn quoted(line: &str) -> Option<&str> {
    line.split_once('"')?.1.rsplit_once('"').map(|(v, _)| v)
}

/// The `Cargo.lock` entries reachable from `yoneda-runtime` (every dependency kind), in file
/// order, as text. Lock entries name dependencies as `name`, `name version` or
/// `name version (source)`.
pub(crate) fn runtime_lock(lock: &str) -> Result<String> {
    let mut entries: Vec<LockEntry> = Vec::new();
    let mut in_dependencies = false;
    for line in lock.lines() {
        if line.starts_with('[') {
            // Every header ends the current entry; only `[[package]]` starts a named one.
            in_dependencies = false;
            entries.push(LockEntry {
                name: "",
                version: "",
                dependencies: Vec::new(),
                text: Vec::new(),
            });
        }
        let Some(entry) = entries.last_mut() else {
            continue;
        };
        entry.text.push(line);
        if in_dependencies {
            if line.trim() == "]" {
                in_dependencies = false;
            } else if let Some(dep) = quoted(line) {
                entry.dependencies.push(dep);
            }
        } else if let Some(name) = line.strip_prefix("name = ") {
            entry.name = quoted(name).unwrap_or_default();
        } else if let Some(version) = line.strip_prefix("version = ") {
            entry.version = quoted(version).unwrap_or_default();
        } else if line == "dependencies = [" {
            in_dependencies = true;
        }
    }
    let find = |dep: &str| -> Result<usize> {
        let mut parts = dep.split(' ');
        let (name, version) = (parts.next().unwrap_or_default(), parts.next());
        let matches: Vec<usize> = entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.name == name && version.is_none_or(|v| e.version == v))
            .map(|(i, _)| i)
            .collect();
        match matches.as_slice() {
            [one] => Ok(*one),
            _ => Err(format!("Cargo.lock: cannot resolve dependency {dep:?}").into()),
        }
    };
    let mut keep = BTreeSet::new();
    let mut queue = vec![find(RUNTIME_CRATE)?];
    while let Some(index) = queue.pop() {
        if keep.insert(index) {
            for dep in &entries[index].dependencies {
                queue.push(find(dep)?);
            }
        }
    }
    Ok(keep
        .iter()
        .map(|i| entries[*i].text.join("\n"))
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// sha256 (hex) over the input list, `git ls-tree -r` of those paths (mode, blob id and
/// path of every file, so any content, mode or file-set change changes the hash) and the
/// runtime's share of `Cargo.lock`.
pub(crate) fn digest(pathspecs: &[String], ls_tree: &str, lock: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(INPUTS_VERSION.as_bytes());
    for path in pathspecs {
        hasher.update(b"\n");
        hasher.update(path.as_bytes());
    }
    hasher.update(b"\n\n");
    hasher.update(ls_tree.as_bytes());
    hasher.update(b"\nCargo.lock\n");
    hasher.update(lock.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn git_output(args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).output()?;
    if !out.status.success() {
        return Err(format!("git {} failed", args.first().unwrap_or(&"")).into());
    }
    Ok(String::from_utf8(out.stdout)?)
}

/// The runtime inputs hash at `revision`. The crate list comes from the working tree's
/// manifests, which the deploy guards keep clean (equal to HEAD).
pub(crate) fn inputs_hash(revision: &str) -> Result<String> {
    let metadata = Command::new("cargo")
        .args(["metadata", "--format-version", "1", "--no-deps", "--locked"])
        .output()?;
    if !metadata.status.success() {
        return Err("cargo metadata failed".into());
    }
    let specs = pathspecs(&runtime_crates(&serde_json::from_slice(&metadata.stdout)?)?);
    let mut args = vec!["ls-tree", "-r", "--full-tree", revision, "--"];
    args.extend(specs.iter().map(String::as_str));
    let tree = git_output(&args)?;
    let lock = git_output(&["show", &format!("{revision}:Cargo.lock")])?;
    Ok(digest(&specs, &tree, &runtime_lock(&lock)?))
}

#[cfg(test)]
#[path = "deploy_inputs/tests.rs"]
mod tests;
