//! `cargo xtask downloads stage|assemble|upload --env dev|prod`: the public downloads the front
//! Worker serves (cloudflare/worker/downloads.ts has the layout).
//!
//! `stage` builds the `yoneda` CLI for each target, packs `yoneda` and `git-remote-yoneda`
//! into `yoneda-<version>-<target>.tar.gz` (a `.zip` of the `.exe` files on Windows), writes
//! SHA256SUMS, `cli/latest.json` and `cli/LATEST`, zips the Claude Code plugin (plugins/yoneda)
//! and fills in the public marketplace (plugins/public-marketplace.json) with the zip's address
//! and sha256, all under `target/downloads/<env>/` at their bucket keys. macOS targets build
//! with Cargo on a Mac; Linux targets are static musl builds and Windows targets MinGW builds,
//! both with `cargo zigbuild` (cargo-zigbuild and zig on PATH). `upload` puts the staged files into `<prefix>-downloads` with wrangler,
//! the version pointers last, so a reader never sees a LATEST whose files are missing;
//! `--dry-run` prints the commands instead. A single-target stage with `--revision` records
//! provenance; `assemble` verifies all target receipts before making one complete release.
use crate::process::{Result, run};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The published targets: name, Rust target, and whether it is built with cargo-zigbuild.
pub(crate) const TARGETS: [(&str, &str, bool); 6] = [
    ("darwin-arm64", "aarch64-apple-darwin", false),
    ("darwin-x64", "x86_64-apple-darwin", false),
    ("linux-x64", "x86_64-unknown-linux-musl", true),
    ("linux-arm64", "aarch64-unknown-linux-musl", true),
    ("windows-x64", "x86_64-pc-windows-gnu", true),
    ("windows-arm64", "aarch64-pc-windows-gnullvm", true),
];
const PROGRAMS: [&str; 2] = ["yoneda", "git-remote-yoneda"];
/// Keys that change between releases: uploaded after everything they point at.
const POINTERS: [&str; 3] = ["cli/latest.json", "claude/marketplace.json", "cli/LATEST"];

mod assemble;
mod package;
mod provenance;
#[cfg(test)]
mod tests;

pub(crate) fn execute(args: &[String]) -> Result<()> {
    let env = option(args, "--env")?.ok_or("downloads needs --env dev|prod")?;
    let spec: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("infra/envs/{env}.json"))?)?;
    let site = spec["vars"]["origin"]
        .as_str()
        .ok_or("the spec has no vars.origin")?;
    let staged = PathBuf::from("target/downloads").join(&env);
    match args.get(1).map(String::as_str) {
        Some("stage") => {
            let only = option(args, "--targets")?;
            let targets: Vec<_> = TARGETS
                .iter()
                .filter(|(name, ..)| {
                    only.as_deref()
                        .is_none_or(|o| o.split(',').any(|t| t == *name))
                })
                .collect();
            if targets.is_empty() {
                let names: Vec<&str> = TARGETS.iter().map(|(name, ..)| *name).collect();
                return Err(format!("--targets names none of {}", names.join(", ")).into());
            }
            let revision = option(args, "--revision")?;
            if let Some(revision) = &revision {
                provenance::verify_checkout(Path::new("."), revision)?;
                if targets.len() != 1 { return Err("--revision staging requires exactly one target".into()); }
            }
            let version = cli_version()?;
            stage(&staged, site, &version, &targets)?;
            if let Some(revision) = revision {
                provenance::verify_checkout(Path::new("."), &revision)?;
                let (target, triple, _) = targets.first().ok_or("No target selected")?;
                provenance::write_receipt(&staged, &version, target, triple, &revision)?;
            }
            Ok(())
        }
        Some("assemble") => {
            let from = option(args, "--from")?.ok_or("assemble needs --from")?;
            let revision = option(args, "--revision")?.ok_or("assemble needs --revision")?;
            provenance::verify_checkout(Path::new("."), &revision)?;
            assemble::assemble(Path::new(&from), &staged, site, &cli_version()?, &revision)
        }
        Some("upload") => {
            let prefix = spec["prefix"].as_str().ok_or("the spec has no prefix")?;
            let account = spec["account_id"]
                .as_str()
                .ok_or("the spec has no account_id")?;
            package::upload(
                &staged,
                &format!("{prefix}-downloads"),
                account,
                args.iter().any(|a| a == "--dry-run"),
            )
        }
        _ => Err(
            "cargo xtask downloads stage [--targets a,b] [--revision sha] | assemble --from dir --revision sha | upload [--dry-run] --env dev|prod"
                .into(),
        ),
    }
}

fn option(args: &[String], name: &str) -> Result<Option<String>> {
    match args.iter().position(|a| a == name) {
        None => Ok(None),
        Some(at) => Ok(Some(
            args.get(at + 1)
                .ok_or(format!("{name} needs a value"))?
                .clone(),
        )),
    }
}

/// The CLI's version: the workspace version in Cargo.toml.
fn cli_version() -> Result<String> {
    let manifest: toml::Value = toml::from_str(&std::fs::read_to_string("Cargo.toml")?)?;
    Ok(manifest["workspace"]["package"]["version"]
        .as_str()
        .ok_or("Cargo.toml has no workspace.package.version")?
        .to_owned())
}

fn stage(staged: &Path, site: &str, version: &str, targets: &[&(&str, &str, bool)]) -> Result<()> {
    if staged.exists() {
        std::fs::remove_dir_all(staged)?;
    }
    let release = staged.join("cli").join(version);
    std::fs::create_dir_all(&release)?;
    let mut built = Vec::new();
    for (target, triple, zig) in targets {
        let build = if *zig { "zigbuild" } else { "build" };
        run(
            "cargo",
            &[
                build,
                "--release",
                "--locked",
                "-p",
                "yoneda-cli",
                "--target",
                triple,
            ],
        )?;
        let name = package::archive_name(version, target);
        let archive = release.join(&name);
        package::pack(target, &format!("target/{triple}/release"), &archive)?;
        let bytes = std::fs::read(&archive)?;
        built.push((*target, bytes.len() as u64, package::sha256_hex(&bytes)));
        println!("staged {name} ({} bytes)", bytes.len());
    }
    package::stage_metadata(staged, site, version, &built)
}
