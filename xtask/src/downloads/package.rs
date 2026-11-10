use super::{POINTERS, PROGRAMS, TARGETS};
use crate::process::Result;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::Command;

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn windows(target: &str) -> bool {
    target.starts_with("windows-")
}

pub(super) fn archive_name(version: &str, target: &str) -> String {
    let extension = if windows(target) { "zip" } else { "tar.gz" };
    format!("yoneda-{version}-{target}.{extension}")
}

/// The files of `PROGRAMS` as `target` builds them.
pub(super) fn program_files(target: &str) -> Vec<String> {
    let suffix = if windows(target) { ".exe" } else { "" };
    PROGRAMS.iter().map(|p| format!("{p}{suffix}")).collect()
}

/// Packs a target's programs: a zip on Windows, whose installer unpacks with what ships in
/// the box. COPYFILE_DISABLE keeps macOS tar from adding AppleDouble `._` files.
pub(super) fn pack(target: &str, bin_dir: &str, archive: &Path) -> Result<()> {
    let programs = program_files(target);
    let status = if windows(target) {
        Command::new("zip")
            .args(["-q", "-j", "-X"])
            .arg(std::env::current_dir()?.join(archive))
            .args(programs)
            .current_dir(bin_dir)
            .status()?
    } else {
        Command::new("tar")
            .env("COPYFILE_DISABLE", "1")
            .arg("-czf")
            .arg(archive)
            .args(["-C", bin_dir])
            .args(programs)
            .status()?
    };
    if status.success() {
        Ok(())
    } else {
        Err(format!("packing {} failed", archive.display()).into())
    }
}

/// `sha256sum` lines: `<hex>  <file>`, sorted by file.
pub(super) fn sha256sums(entries: &[(String, String)]) -> String {
    let mut lines: Vec<String> = entries
        .iter()
        .map(|(name, sum)| format!("{sum}  {name}"))
        .collect();
    lines.sort_by(|a, b| a[66..].cmp(&b[66..]));
    lines.iter().map(|l| format!("{l}\n")).collect()
}

/// `cli/latest.json`: the release and each target's archive, size and sha256.
pub(super) fn manifest(site: &str, version: &str, built: &[(&str, u64, String)]) -> Value {
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
        "install_windows": format!("irm {site}/install.ps1 | iex"),
        "sha256sums": format!("{site}/downloads/cli/{version}/SHA256SUMS"),
        "targets": targets,
    })
}

/// The public marketplace: the template with the plugin zip's address and sha256.
pub(super) fn marketplace(template: &str, site: &str, version: &str, sum: &str) -> String {
    template
        .replace("{site}", site)
        .replace("{version}", version)
        .replace("{sha256}", sum)
}

pub(super) fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, bytes)?;
    Ok(())
}

pub(super) fn stage_metadata(
    staged: &Path,
    site: &str,
    version: &str,
    built: &[(&str, u64, String)],
) -> Result<()> {
    stage_plugin(staged, site)?;
    let release = staged.join("cli").join(version);
    for name in ["install.sh", "install.ps1"] {
        let script = std::fs::read_to_string(Path::new("frontend/public").join(name))?
            .replace("__YONEDA_SITE__", site);
        write(&release.join(name), script.as_bytes())?;
    }
    let sums: Vec<(String, String)> = built
        .iter()
        .map(|(target, _, sum)| (archive_name(version, target), sum.clone()))
        .collect();
    write(&release.join("SHA256SUMS"), sha256sums(&sums).as_bytes())?;
    let latest = serde_json::to_string_pretty(&manifest(site, version, built))?;
    write(
        &staged.join("cli/latest.json"),
        format!("{latest}\n").as_bytes(),
    )?;
    write(
        &staged.join("cli/LATEST"),
        format!("{version}\n").as_bytes(),
    )?;
    Ok(())
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
pub(super) fn upload_order(staged: &Path) -> Result<Vec<String>> {
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

pub(super) fn upload(staged: &Path, bucket: &str, account: &str, dry_run: bool) -> Result<()> {
    validate_release(staged)?;
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

/// Publishing a partial per-target stage must never replace the complete release.
pub(super) fn validate_release(staged: &Path) -> Result<()> {
    let latest = std::fs::read_to_string(staged.join("cli/LATEST"))?;
    let version = latest.trim();
    if version.is_empty() || version.contains(['/', '\\']) || version == "." || version == ".." {
        return Err("Invalid staged CLI version".into());
    }
    let value: Value = serde_json::from_slice(&std::fs::read(staged.join("cli/latest.json"))?)?;
    let targets = value["targets"]
        .as_object()
        .ok_or("Staged CLI manifest has no targets")?;
    if value["version"] != version || targets.len() != TARGETS.len() {
        return Err("Publishing requires the complete CLI target cohort".into());
    }
    let mut sums = Vec::new();
    for (target, ..) in TARGETS {
        let name = archive_name(version, target);
        let path = staged.join("cli").join(version).join(&name);
        super::provenance::regular(&path)?;
        let bytes = std::fs::read(path)?;
        let sum = sha256_hex(&bytes);
        let metadata = targets
            .get(target)
            .ok_or("Staged CLI manifest is missing a target")?;
        if bytes.is_empty()
            || metadata["sha256"] != sum
            || metadata["size"] != u64::try_from(bytes.len())?
            || !metadata["url"]
                .as_str()
                .is_some_and(|url| url.ends_with(&format!("/cli/{version}/{name}")))
        {
            return Err("Staged CLI archive differs from its manifest".into());
        }
        sums.push((name, sum));
    }
    if std::fs::read_to_string(staged.join("cli").join(version).join("SHA256SUMS"))?
        != sha256sums(&sums)
    {
        return Err("Staged CLI checksum inventory is incomplete".into());
    }
    let market: Value =
        serde_json::from_slice(&std::fs::read(staged.join("claude/marketplace.json"))?)?;
    let source = &market["plugins"][0]["source"];
    let name = source["url"]
        .as_str()
        .and_then(|url| url.rsplit('/').next())
        .ok_or("Staged plugin has no archive URL")?;
    if !name.starts_with("yoneda-")
        || !name.ends_with(".zip")
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err("Invalid staged plugin archive name".into());
    }
    let plugin = staged.join("claude").join(name);
    super::provenance::regular(&plugin)?;
    if source["sha256"] != sha256_hex(&std::fs::read(plugin)?) {
        return Err("Staged plugin checksum differs from its marketplace".into());
    }
    Ok(())
}
