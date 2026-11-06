//! Validate the entire six-target cohort before creating release pointers.
use super::TARGETS;
use super::package::{archive_name, sha256_hex, stage_metadata, write};
use super::provenance::{Receipt, regular};
use crate::process::Result;
use std::path::Path;

pub(super) struct Archive {
    pub target: &'static str,
    pub name: String,
    pub bytes: Vec<u8>,
    pub sum: String,
}

fn directory(path: &Path) -> Result<()> {
    if !std::fs::symlink_metadata(path)?.file_type().is_dir() {
        return Err("CLI artifact directory cannot be a symlink".into());
    }
    Ok(())
}

fn artifact_files(root: &Path, relative: &str, version: &str, out: &mut Vec<String>) -> Result<()> {
    directory(&root.join(relative))?;
    for entry in std::fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Invalid CLI artifact file name")?;
        let path = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let kind = entry.file_type()?;
        if kind.is_dir() && (path == "cli" || path == format!("cli/{version}")) {
            artifact_files(root, &path, version, out)?;
        } else if kind.is_file() {
            out.push(path);
        } else {
            return Err("Unexpected CLI artifact directory or symlink".into());
        }
    }
    Ok(())
}

pub(super) fn validate(input: &Path, version: &str, revision: &str) -> Result<Vec<Archive>> {
    directory(input)?;
    let mut names = Vec::new();
    for entry in std::fs::read_dir(input)? {
        let entry = entry?;
        directory(&entry.path())?;
        names.push(
            entry
                .file_name()
                .into_string()
                .map_err(|_| "Invalid CLI artifact name")?,
        );
    }
    names.sort();
    let mut expected: Vec<_> = TARGETS
        .iter()
        .map(|(target, ..)| format!("cli-{target}-{revision}"))
        .collect();
    expected.sort();
    if names != expected {
        return Err("CLI artifacts must contain exactly the complete target cohort".into());
    }
    let mut archives = Vec::new();
    for (target, triple, _) in TARGETS {
        let root = input.join(format!("cli-{target}-{revision}"));
        let name = archive_name(version, target);
        let mut files = Vec::new();
        artifact_files(&root, "", version, &mut files)?;
        files.sort();
        if files != [format!("cli/{version}/{name}"), "receipt.json".into()] {
            return Err("CLI artifact must contain only its archive and receipt".into());
        }
        let receipt_path = root.join("receipt.json");
        regular(&receipt_path)?;
        let receipt: Receipt = serde_json::from_slice(&std::fs::read(receipt_path)?)?;
        if receipt.schema != 1
            || receipt.revision != revision
            || receipt.version != version
            || receipt.target != target
            || receipt.triple != triple
            || receipt.archive != name
        {
            return Err("CLI artifact provenance does not match this release".into());
        }
        let path = root.join("cli").join(version).join(&name);
        regular(&path)?;
        let bytes = std::fs::read(path)?;
        let sum = sha256_hex(&bytes);
        if bytes.is_empty() || receipt.size != u64::try_from(bytes.len())? || receipt.sha256 != sum
        {
            return Err("CLI artifact checksum or size differs from its receipt".into());
        }
        archives.push(Archive {
            target,
            name,
            bytes,
            sum,
        });
    }
    Ok(archives)
}

pub(super) fn assemble(
    input: &Path,
    staged: &Path,
    site: &str,
    version: &str,
    revision: &str,
) -> Result<()> {
    let archives = validate(input, version, revision)?;
    // No destination or pointer is touched until every input archive has passed.
    if staged.exists() {
        std::fs::remove_dir_all(staged)?;
    }
    let mut built = Vec::new();
    for archive in archives {
        write(
            &staged.join("cli").join(version).join(archive.name),
            &archive.bytes,
        )?;
        built.push((
            archive.target,
            u64::try_from(archive.bytes.len())?,
            archive.sum,
        ));
    }
    stage_metadata(staged, site, version, &built)
}

#[cfg(test)]
#[path = "assemble_tests.rs"]
mod tests;
