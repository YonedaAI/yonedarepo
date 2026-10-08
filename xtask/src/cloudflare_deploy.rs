//! Deploy a reviewed account-specific configuration; keep existing secrets intact.
use crate::{
    cloudflare::{deployment, private, wrangler},
    process::{Result, run},
};
use serde_json::{Value, json};
use std::{path::Path, process::Command};

pub(crate) async fn deploy(args: &[String]) -> Result<()> {
    let dir = deployment(args)?;
    let manifest: Value = serde_json::from_slice(&std::fs::read(dir.join("deployment.json"))?)?;
    let platform = dir.join("platform.json");
    let sites = dir.join("sites.json");
    if let Ok(account) = std::env::var("CLOUDFLARE_ACCOUNT_ID")
        && manifest["account_id"] != account
    {
        return Err("CLOUDFLARE_ACCOUNT_ID differs from deployment manifest".into());
    }
    for path in [&platform, &sites] {
        let config: Value = serde_json::from_slice(&std::fs::read(path)?)?;
        if config["account_id"] != manifest["account_id"] {
            return Err("Config account differs from deployment manifest".into());
        }
        let expected = if path == &platform {
            manifest["name"].clone()
        } else {
            json!(format!(
                "{}-sites",
                manifest["name"].as_str().ok_or("Missing name")?
            ))
        };
        if config["name"] != expected {
            return Err("Config Worker name differs from deployment manifest".into());
        }
        if path == &platform
            && (config["vars"]["ARTIFACTS_NAMESPACE"] != manifest["namespace"]
                || config["vars"]["SITE_ORIGIN"] != manifest["sites_url"]
                || config["d1_databases"][0]["database_id"] != manifest["database_id"])
        {
            return Err(
                "Config namespace, site origin or database differs from deployment manifest".into(),
            );
        }
    }
    crate::commands::build_wasm()?;
    run("pnpm", &["--dir", "web", "build"])?;
    if args.iter().any(|v| v == "--dry-run") {
        wrangler(
            &platform,
            &["deploy", "--dry-run", "--containers-rollout", "none"],
        )?;
        wrangler(&sites, &["deploy", "--dry-run"])?;
        println!("Dry run passed. No remote resources or credentials changed.");
        return Ok(());
    }
    let (upload, owner) = secrets(&dir, &platform)?;
    wrangler(
        &platform,
        &["d1", "migrations", "apply", "INDEX", "--remote"],
    )?;
    let secret_path = dir.join("secrets.upload.json");
    std::fs::write(&secret_path, serde_json::to_vec(&upload)?)?;
    private(&secret_path, false)?;
    let result = wrangler(
        &platform,
        &[
            "deploy",
            "--secrets-file",
            secret_path.to_str().ok_or("Invalid secret file path")?,
            "--durable-objects-code-update-mode",
            "immediate",
        ],
    );
    let cleanup = std::fs::remove_file(&secret_path);
    result?;
    cleanup?;
    wrangler(&sites, &["deploy"])?;
    let url = manifest["platform_url"]
        .as_str()
        .ok_or("Missing platform URL")?;
    let health = reqwest::get(format!("{url}/health"))
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    if health["service"] != "yonedarepo" {
        return Err("Deployed health response did not identify YonedaRepo".into());
    }
    crate::bootstrap::seed_template_authenticated(url, &owner).await?;
    println!(
        "Deployed and starter verified: {url}\nSites: {}\nSign up in the browser, then add your provider keys. No paid agent run was started.",
        manifest["sites_url"].as_str().unwrap_or_default()
    );
    Ok(())
}
fn secrets(dir: &Path, config: &Path) -> Result<(Value, String)> {
    let inventory = Command::new("pnpm")
        .args([
            "exec",
            "wrangler",
            "secret",
            "list",
            "--format",
            "json",
            "--config",
            config.to_str().ok_or("Invalid config path")?,
        ])
        .output()?;
    let existing = parse_inventory(
        inventory.status.success(),
        &inventory.stdout,
        &inventory.stderr,
    )?;
    let list = existing
        .as_array()
        .ok_or("Unexpected secret inventory; refusing changes")?;
    let mut upload = json!({});
    for (name, file, hex) in [
        ("OWNER_TOKEN", "owner-token", false),
        ("VAULT_KEY", "vault-key", true),
    ] {
        let path = dir.join(file);
        let present = list.iter().any(|v| v["name"] == name);
        if present && name == "OWNER_TOKEN" && !path.exists() {
            return Err(format!("Existing operator token needs a private local copy at {} for starter bootstrap; refusing rotation",path.display()).into());
        }
        if !present {
            if !path.exists() {
                let key = if hex {
                    format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    )
                } else {
                    format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())
                };
                std::fs::write(&path, key)?;
                private(&path, false)?;
            }
            let key = std::fs::read_to_string(&path)?.trim().to_owned();
            if key.len() < 32
                || (hex && (key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit())))
            {
                return Err(format!("Invalid private {name} backup").into());
            }
            upload[name] = json!(key);
        }
    }
    Ok((
        upload,
        std::fs::read_to_string(dir.join("owner-token"))?
            .trim()
            .into(),
    ))
}

fn parse_inventory(success: bool, stdout: &[u8], stderr: &[u8]) -> Result<Value> {
    if success {
        return Ok(serde_json::from_slice(stdout)?);
    }
    let diagnostic = String::from_utf8_lossy(stderr).to_lowercase();
    if diagnostic.contains("10007") || diagnostic.contains("worker does not exist") {
        return Ok(json!([]));
    }
    Err("Cannot inventory Worker secrets; refusing to overwrite them. Check Wrangler login, account and permissions.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_missing_worker_allows_initial_secret_creation() {
        assert_eq!(
            parse_inventory(false, b"", b"Worker not found [code: 10007]").unwrap(),
            json!([])
        );
        assert!(parse_inventory(false, b"", b"Authentication error [code: 10000]").is_err());
        assert!(parse_inventory(false, b"", b"Network unavailable").is_err());
        assert!(parse_inventory(true, b"not json", b"").is_err());
        assert_eq!(
            parse_inventory(true, br#"[{"name":"VAULT_KEY"}]"#, b"").unwrap()[0]["name"],
            "VAULT_KEY"
        );
    }
}
