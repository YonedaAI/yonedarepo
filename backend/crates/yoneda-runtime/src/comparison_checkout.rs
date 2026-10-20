//! Supervisor-owned captured checkouts; inspect every path, including ignored files.
use crate::err;
use serde_json::json;
use std::{collections::BTreeMap, fs, os::unix::fs::PermissionsExt, path::Path};
use yoneda_agents_core::{Result, Workspace};

pub(crate) fn materialize(root: &Path, sources: &[(String, Workspace)]) -> Result<String> {
    if sources.len() > 2 || fs::read_dir(root).map_err(err)?.next().is_some() {
        return Err(err(
            "Review checkout must be a fresh supervisor-owned directory",
        ));
    }
    for (index, (_, files)) in sources.iter().enumerate() {
        crate::workspace::materialize_unbounded(&root.join(format!("candidate-{index}")), files)?;
    }
    fs::write(root.join("comparison-sources.json"), json!(sources.iter().enumerate().map(|(index,(id,_))|json!({"candidate_id":id,"directory":format!("candidate-{index}")})).collect::<Vec<_>>()).to_string()).map_err(err)?;
    let mut paths = Vec::new();
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(err)?;
        if entry.file_type().is_symlink() {
            return Err(err("Review sources cannot contain symlinks"));
        }
        paths.push((entry.path().to_owned(), entry.file_type().is_dir()));
    }
    for (path, directory) in paths.iter().rev() {
        let executable = fs::metadata(path).map_err(err)?.permissions().mode() & 0o111 != 0;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if *directory || executable {
                0o555
            } else {
                0o444
            }),
        )
        .map_err(err)?;
    }
    fingerprint(root)
}

pub(crate) fn verify(root: &Path, expected: &str) -> Result<()> {
    if fingerprint(root)? != expected {
        return Err(err(
            "Comparison review changed captured source or checkout permissions",
        ));
    }
    Ok(())
}

fn fingerprint(root: &Path) -> Result<String> {
    let mut records = BTreeMap::new();
    let mut bytes = 0usize;
    for entry in walkdir::WalkDir::new(root).follow_links(false) {
        let entry = entry.map_err(err)?;
        if entry.file_type().is_symlink() {
            return Err(err("Comparison review introduced a symlink"));
        }
        let path = entry
            .path()
            .strip_prefix(root)
            .map_err(err)?
            .to_str()
            .ok_or_else(|| err("Non-UTF8 review source"))?;
        let mode = fs::symlink_metadata(entry.path())
            .map_err(err)?
            .permissions()
            .mode()
            & 0o777;
        if entry.file_type().is_dir() {
            records.insert(path.to_owned(), json!({"directory":true,"mode":mode}));
            continue;
        }
        let file = crate::secure_fs::read_regular_bounded(root, path, 32000000)?;
        let content = file.bytes()?;
        bytes = bytes
            .checked_add(content.len())
            .ok_or_else(|| err("Review source size overflow"))?;
        if bytes > 201 * 1024 * 1024 || records.len() > 22000 {
            return Err(err("Comparison checkout exceeds source limits"));
        }
        records.insert(
            path.to_owned(),
            json!({"digest":yoneda_agents_core::digest(&content),"mode":mode}),
        );
    }
    yoneda_agents_core::fingerprint(&json!(records))
}

#[cfg(test)]
#[path = "tests/comparison_checkout.rs"]
mod tests;
