//! `cargo xtask downloads stage|upload --env dev|prod`: the public downloads the front
//! Worker serves (cloudflare/worker/downloads.ts has the layout).
//!
//! `stage` builds the `yoneda` CLI for each target, packs `yoneda` and `git-remote-yoneda`
//! into `yoneda-<version>-<target>.tar.gz`, writes SHA256SUMS, `cli/latest.json` and
//! `cli/LATEST`, zips the Claude Code plugin (plugins/yoneda) and fills in the public
//! marketplace (plugins/public-marketplace.json) with the zip's address and sha256, all
//! under `target/downloads/<env>/` at their bucket keys. macOS targets build with Cargo on
//! a Mac; Linux targets are static musl builds with `cargo zigbuild` (cargo-zigbuild and
//! zig on PATH). `upload` puts the staged files into `<prefix>-downloads` with wrangler,
//! the version pointers last, so a reader never sees a LATEST whose files are missing;
//! `--dry-run` prints the commands instead.
use crate::process::{Result, run};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The published targets: name, Rust target, and whether it is built with cargo-zigbuild.
pub(crate) const TARGETS: [(&str, &str, bool); 4] = [
    ("darwin-arm64", "aarch64-apple-darwin", false),
    ("darwin-x64", "x86_64-apple-darwin", false),
    ("linux-x64", "x86_64-unknown-linux-musl", true),
    ("linux-arm64", "aarch64-unknown-linux-musl", true),
];
const PROGRAMS: [&str; 2] = ["yoneda", "git-remote-yoneda"];
/// Keys that change between releases: uploaded after everything they point at.
const POINTERS: [&str; 3] = ["cli/LATEST", "cli/latest.json", "claude/marketplace.json"];

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
                return Err(
                    "--targets names none of darwin-arm64, darwin-x64, linux-x64, linux-arm64"
                        .into(),
                );
            }
            stage(&staged, site, &cli_version()?, &targets)
        }
        Some("upload") => {
            let prefix = spec["prefix"].as_str().ok_or("the spec has no prefix")?;
            let account = spec["account_id"]
                .as_str()
                .ok_or("the spec has no account_id")?;
            upload(
                &staged,
                &format!("{prefix}-downloads"),
                account,
                args.iter().any(|a| a == "--dry-run"),
            )
        }
        _ => Err(
            "cargo xtask downloads stage [--targets a,b] | upload [--dry-run] --env dev|prod"
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

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub(crate) fn archive_name(version: &str, target: &str) -> String {
    format!("yoneda-{version}-{target}.tar.gz")
}

/// `sha256sum` lines: `<hex>  <file>`, sorted by file.
pub(crate) fn sha256sums(entries: &[(String, String)]) -> String {
    let mut lines: Vec<String> = entries
        .iter()
        .map(|(name, sum)| format!("{sum}  {name}"))
        .collect();
    lines.sort_by(|a, b| a[66..].cmp(&b[66..]));
    lines.iter().map(|l| format!("{l}\n")).collect()
}

/// `cli/latest.json`: the release and each target's archive, size and sha256.
pub(crate) fn manifest(site: &str, version: &str, built: &[(&str, u64, String)]) -> Value {
    let targets: serde_json::Map<String, Value> = built
        .iter()
        .map(|(target, size, sum)| {
            let url = format!(
                "{site}/downloads/cli/{version}/{}",
                archive_name(version, target)
            );
            (
                (*target).to_owned(),
                json!({"url": url, "size": size, "sha256": sum}),
            )
        })
        .collect();
    json!({
        "version": version,
        "install": format!("curl -fsSL {site}/install.sh | sh"),
        "sha256sums": format!("{site}/downloads/cli/{version}/SHA256SUMS"),
        "targets": targets,
    })
}

/// The public marketplace: the template with the plugin zip's address and sha256.
pub(crate) fn marketplace(template: &str, site: &str, version: &str, sum: &str) -> String {
    template
        .replace("{site}", site)
        .replace("{version}", version)
        .replace("{sha256}", sum)
}

fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
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
        let name = archive_name(version, target);
        let archive = release.join(&name);
        let bin_dir = format!("target/{triple}/release");
        // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble `._` files.
        let status = Command::new("tar")
            .env("COPYFILE_DISABLE", "1")
            .arg("-czf")
            .arg(&archive)
            .args(["-C", &bin_dir])
            .args(PROGRAMS)
            .status()?;
        if !status.success() {
            return Err(format!("packing {name} failed").into());
        }
        let bytes = std::fs::read(&archive)?;
        built.push((*target, bytes.len() as u64, sha256_hex(&bytes)));
        println!("staged {name} ({} bytes)", bytes.len());
    }
    let sums: Vec<(String, String)> = built
        .iter()
        .map(|(target, _, sum)| (archive_name(version, target), sum.clone()))
        .collect();
    write(&release.join("SHA256SUMS"), sha256sums(&sums).as_bytes())?;
    let latest = serde_json::to_string_pretty(&manifest(site, version, &built))?;
    write(
        &staged.join("cli/latest.json"),
        format!("{latest}\n").as_bytes(),
    )?;
    write(
        &staged.join("cli/LATEST"),
        format!("{version}\n").as_bytes(),
    )?;
    stage_plugin(staged, site)
}

/// The plugin zip (its root at the top of the zip) and the marketplace that pins it.
fn stage_plugin(staged: &Path, site: &str) -> Result<()> {
    let plugin: Value = serde_json::from_str(&std::fs::read_to_string(
        "plugins/yoneda/.claude-plugin/plugin.json",
    )?)?;
    let version = plugin["version"]
        .as_str()
        .ok_or("plugin.json has no version")?;
    let zip = std::env::current_dir()?
        .join(staged)
        .join(format!("claude/yoneda-{version}.zip"));
    std::fs::create_dir_all(zip.parent().ok_or("no parent")?)?;
    // -X leaves out extra file attributes, so the zip depends only on the files.
    let status = Command::new("zip")
        .args(["-q", "-r", "-X"])
        .arg(&zip)
        .arg(".")
        .current_dir("plugins/yoneda")
        .status()?;
    if !status.success() {
        return Err("zipping plugins/yoneda failed (is zip installed?)".into());
    }
    let sum = sha256_hex(&std::fs::read(&zip)?);
    let template = std::fs::read_to_string("plugins/public-marketplace.json")?;
    write(
        &staged.join("claude/marketplace.json"),
        marketplace(&template, site, version, &sum).as_bytes(),
    )?;
    println!("staged claude/yoneda-{version}.zip and claude/marketplace.json");
    Ok(())
}

/// Every staged file's bucket key, the version pointers last.
pub(crate) fn upload_order(staged: &Path) -> Result<Vec<String>> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                walk(&path, out)?;
            } else {
                out.push(path);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    walk(staged, &mut files)?;
    let mut keys: Vec<String> = files
        .iter()
        .filter_map(|p| p.strip_prefix(staged).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .collect();
    keys.sort_by_key(|k| (POINTERS.iter().position(|p| p == k), k.clone()));
    if keys.is_empty() {
        return Err(format!(
            "nothing staged in {}: run downloads stage first",
            staged.display()
        )
        .into());
    }
    Ok(keys)
}

fn upload(staged: &Path, bucket: &str, account: &str, dry_run: bool) -> Result<()> {
    for key in upload_order(staged)? {
        let file = staged.join(&key);
        let object = format!("{bucket}/{key}");
        let file = file.to_str().ok_or("invalid path")?;
        let args = [
            "exec", "wrangler", "r2", "object", "put", &object, "--file", file, "--remote",
        ];
        if dry_run {
            println!("CLOUDFLARE_ACCOUNT_ID={account} pnpm {}", args.join(" "));
            continue;
        }
        let status = Command::new("pnpm")
            .args(args)
            .env("CLOUDFLARE_ACCOUNT_ID", account)
            .status()?;
        if !status.success() {
            return Err(format!("uploading {key} failed").into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_each_archive_and_lists_its_sum_like_sha256sum() {
        assert_eq!(
            archive_name("0.1.0", "linux-x64"),
            "yoneda-0.1.0-linux-x64.tar.gz"
        );
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let sums = sha256sums(&[
            ("yoneda-0.1.0-linux-x64.tar.gz".into(), b.clone()),
            ("yoneda-0.1.0-darwin-arm64.tar.gz".into(), a.clone()),
        ]);
        assert_eq!(
            sums,
            format!("{a}  yoneda-0.1.0-darwin-arm64.tar.gz\n{b}  yoneda-0.1.0-linux-x64.tar.gz\n")
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn manifest_points_at_the_site_and_each_archive() {
        let m = manifest(
            "https://yonedarepo.com",
            "0.1.0",
            &[("linux-arm64", 7, "c".repeat(64))],
        );
        assert_eq!(m["version"], "0.1.0");
        assert_eq!(
            m["install"],
            "curl -fsSL https://yonedarepo.com/install.sh | sh"
        );
        assert_eq!(
            m["targets"]["linux-arm64"]["url"],
            "https://yonedarepo.com/downloads/cli/0.1.0/yoneda-0.1.0-linux-arm64.tar.gz"
        );
        assert_eq!(m["targets"]["linux-arm64"]["size"], 7);
    }

    #[test]
    fn fills_the_public_marketplace_template() -> Result<()> {
        let template = std::fs::read_to_string("../plugins/public-marketplace.json")?;
        let filled = marketplace(
            &template,
            "https://yonedarepo.com",
            "0.2.0",
            &"d".repeat(64),
        );
        let market: Value = serde_json::from_str(&filled)?;
        assert_eq!(
            market["plugins"][0]["source"],
            json!({
                "source": "archive",
                "url": "https://yonedarepo.com/downloads/claude/yoneda-0.2.0.zip",
                "sha256": "d".repeat(64),
            })
        );
        assert!(!filled.contains("{site}") && !filled.contains("{sha256}"));
        Ok(())
    }

    #[test]
    fn uploads_the_version_pointers_last() -> Result<()> {
        let dir = tempfile::tempdir()?;
        for key in [
            "claude/marketplace.json",
            "cli/LATEST",
            "cli/0.1.0/SHA256SUMS",
            "claude/yoneda-0.2.0.zip",
            "cli/latest.json",
            "cli/0.1.0/yoneda-0.1.0-linux-x64.tar.gz",
        ] {
            write(&dir.path().join(key), b"x")?;
        }
        assert_eq!(
            upload_order(dir.path())?,
            [
                "claude/yoneda-0.2.0.zip",
                "cli/0.1.0/SHA256SUMS",
                "cli/0.1.0/yoneda-0.1.0-linux-x64.tar.gz",
                "cli/LATEST",
                "cli/latest.json",
                "claude/marketplace.json",
            ]
        );
        assert!(upload_order(&dir.path().join("none")).is_err());
        Ok(())
    }
}
