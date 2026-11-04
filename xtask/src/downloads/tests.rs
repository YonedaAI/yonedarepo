use super::package::*;
use super::*;
use serde_json::json;

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
    assert_eq!(
        m["install_windows"],
        "irm https://yonedarepo.com/install.ps1 | iex"
    );
}

#[test]
fn windows_targets_ship_zips_of_exe_files_built_with_zig() {
    assert_eq!(
        archive_name("0.1.0", "windows-x64"),
        "yoneda-0.1.0-windows-x64.zip"
    );
    assert_eq!(
        archive_name("0.1.0", "windows-arm64"),
        "yoneda-0.1.0-windows-arm64.zip"
    );
    assert_eq!(
        archive_name("0.1.0", "darwin-x64"),
        "yoneda-0.1.0-darwin-x64.tar.gz"
    );
    assert_eq!(
        program_files("windows-x64"),
        ["yoneda.exe", "git-remote-yoneda.exe"]
    );
    assert_eq!(program_files("linux-x64"), ["yoneda", "git-remote-yoneda"]);
    for name in ["windows-x64", "windows-arm64"] {
        assert!(
            TARGETS.iter().any(|(n, _, zig)| *n == name && *zig),
            "{name}"
        );
    }
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
            "cli/latest.json",
            "claude/marketplace.json",
            "cli/LATEST",
        ]
    );
    assert!(upload_order(&dir.path().join("none")).is_err());
    Ok(())
}

#[test]
fn upload_requires_every_archive_manifest_sum_and_plugin_before_any_r2_call() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let version = "0.1.0";
    let mut built = Vec::new();
    let mut sums = Vec::new();
    for (target, ..) in TARGETS {
        let bytes = target.as_bytes();
        let sum = sha256_hex(bytes);
        let name = archive_name(version, target);
        write(&dir.path().join("cli").join(version).join(&name), bytes)?;
        built.push((target, u64::try_from(bytes.len())?, sum.clone()));
        sums.push((name, sum));
    }
    write(&dir.path().join("cli/LATEST"), b"0.1.0\n")?;
    write(
        &dir.path().join("cli/latest.json"),
        &serde_json::to_vec(&manifest("https://example.test", version, &built))?,
    )?;
    write(
        &dir.path().join("cli").join(version).join("SHA256SUMS"),
        sha256sums(&sums).as_bytes(),
    )?;
    write(&dir.path().join("claude/yoneda-0.2.0.zip"), b"plugin")?;
    write(
        &dir.path().join("claude/marketplace.json"),
        &serde_json::to_vec(
            &json!({"plugins":[{"source":{"url":"https://example.test/downloads/claude/yoneda-0.2.0.zip","sha256":sha256_hex(b"plugin")}}]}),
        )?,
    )?;
    validate_release(dir.path())?;
    std::fs::remove_file(
        dir.path()
            .join("cli")
            .join(version)
            .join(archive_name(version, TARGETS[0].0)),
    )?;
    // Even dry-run upload preflights the complete cohort before invoking wrangler.
    assert!(upload(dir.path(), "fixture", "fixture", true).is_err());
    Ok(())
}
