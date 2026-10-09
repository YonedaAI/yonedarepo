//! Portable configuration; never reuse the project's development resource identities.
use crate::process::{Result, run};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn option<'a>(args: &'a [String], name: &str) -> Result<&'a str> {
    args.windows(2)
        .find(|v| v[0] == name)
        .map(|v| v[1].as_str())
        .ok_or_else(|| format!("Missing {name}").into())
}
fn slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !value.starts_with('-')
        && !value.ends_with('-')
}
pub(crate) fn directory(name: &str) -> Result<PathBuf> {
    if !slug(name) {
        return Err("Use a lowercase deployment name, digits and hyphens (1–40 characters)".into());
    }
    Ok(Path::new(".local/deploy").join(name))
}
pub(crate) fn configure(args: &[String]) -> Result<()> {
    let name = option(args, "--name")?;
    let account = option(args, "--account-id")?;
    let namespace = option(args, "--namespace")?;
    let subdomain = option(args, "--subdomain")?;
    let database = option(args, "--database-id")?;
    if account.len() != 32
        || !account.bytes().all(|b| b.is_ascii_hexdigit())
        || !slug(namespace)
        || !slug(subdomain)
        || uuid::Uuid::parse_str(database).is_err()
    {
        return Err("Invalid account, namespace, workers.dev subdomain or D1 UUID".into());
    }
    let dir = directory(name)?;
    let manifest = json!({"name":name,"account_id":account,"namespace":namespace,"database_id":database,"platform_url":format!("https://{name}.{subdomain}.workers.dev"),"sites_url":format!("https://{name}-sites.{subdomain}.workers.dev")});
    std::fs::create_dir_all(&dir)?;
    private(&dir, true)?;
    let template: Value = serde_json::from_slice(&std::fs::read(crate::layout::PLATFORM_CONFIG)?)?;
    save_configs(&dir, &manifest, template)?;
    println!(
        "Configuration saved in {}. Review it before deployment.",
        dir.display()
    );
    println!(
        "Known legacy source paths were upgraded; custom paths and saved resource identities were retained. Review custom source paths manually if they refer to the previous layout."
    );
    println!(
        "One-time resources (skip resources that already exist):\npnpm exec wrangler r2 bucket create {name}-objects --config {0}/platform.json\npnpm exec wrangler d1 create {name}-index --config {0}/platform.json",
        dir.display()
    );
    for suffix in ["agent", "capture", "evaluate", "publish", "dead-letter"] {
        println!(
            "pnpm exec wrangler queues create {name}-{suffix} --config {}/platform.json",
            dir.display()
        );
    }
    println!(
        "Set the D1 UUID with --database-id when configuring. Artifacts namespace creation and billing prerequisites are documented in README.md. Deploy: cargo xtask cloudflare-deploy --name {name}"
    );
    Ok(())
}
fn save_configs(dir: &Path, manifest: &Value, template: Value) -> Result<()> {
    let manifest_path = dir.join("deployment.json");
    if manifest_path.exists()
        && serde_json::from_slice::<Value>(&std::fs::read(&manifest_path)?)? != *manifest
    {
        return Err(
            "Deployment identity differs from saved configuration; choose another --name".into(),
        );
    }
    let (platform, sites) = configs(template, manifest);
    for (filename, value) in [
        ("deployment.json", manifest.clone()),
        ("platform.json", platform),
        ("sites.json", sites),
    ] {
        let path = dir.join(filename);
        if path.exists() {
            if filename == "deployment.json" {
                continue;
            }
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path)?).map_err(|error| {
                format!("Cannot upgrade {}: {error}. Retain its identities and manually update source paths for the frontend/backend/cloudflare layout.", path.display())
            })?;
            if upgrade_paths(&mut saved, filename == "sites.json") {
                std::fs::write(&path, serde_json::to_vec_pretty(&saved)?)?;
            }
        } else {
            std::fs::write(&path, serde_json::to_vec_pretty(&value)?)?;
        }
    }
    Ok(())
}
fn upgrade_paths(config: &mut Value, sites: bool) -> bool {
    let mut changed = replace_path(
        config,
        "/main",
        if sites {
            "../../../sites/index.ts"
        } else {
            "../../../worker/index.ts"
        },
        if sites {
            "../../../cloudflare/sites/index.ts"
        } else {
            "../../../cloudflare/worker/index.ts"
        },
    );
    if !sites {
        changed |= replace_path(
            config,
            "/assets/directory",
            "../../../web/dist",
            "../../../frontend/dist",
        );
        if let Some(containers) = config.get_mut("containers").and_then(Value::as_array_mut) {
            for container in containers {
                changed |= replace_path(
                    container,
                    "/image",
                    "../../../containers/Dockerfile",
                    "../../../cloudflare/containers/Dockerfile",
                );
            }
        }
        if let Some(databases) = config.get_mut("d1_databases").and_then(Value::as_array_mut) {
            for database in databases {
                changed |= replace_path(
                    database,
                    "/migrations_dir",
                    "../../../migrations",
                    "../../../cloudflare/migrations",
                );
            }
        }
    }
    changed
}
fn replace_path(config: &mut Value, pointer: &str, old: &str, new: &str) -> bool {
    if let Some(value) = config
        .pointer_mut(pointer)
        .filter(|value| value.as_str() == Some(old))
    {
        *value = json!(new);
        true
    } else {
        false
    }
}
fn configs(mut platform: Value, m: &Value) -> (Value, Value) {
    let name = m["name"].as_str().unwrap_or_default();
    platform["name"] = m["name"].clone();
    platform["account_id"] = m["account_id"].clone();
    platform["main"] = json!("../../../cloudflare/worker/index.ts");
    platform["$schema"] = json!("../../../node_modules/wrangler/config-schema.json");
    platform["assets"]["directory"] = json!("../../../frontend/dist");
    platform["vars"]["ARTIFACTS_NAMESPACE"] = m["namespace"].clone();
    platform["vars"]["SITE_ORIGIN"] = m["sites_url"].clone();
    platform["services"][0]["service"] = m["name"].clone();
    platform
        .as_object_mut()
        .map(|p| p.remove("secrets_store_secrets"));
    platform["artifacts"][0]["namespace"] = m["namespace"].clone();
    platform["containers"][0]["image"] = json!("../../../cloudflare/containers/Dockerfile");
    platform["containers"][0]["image_build_context"] = json!("../../..");
    platform["r2_buckets"][0]["bucket_name"] = json!(format!("{name}-objects"));
    platform["d1_databases"][0] = json!({"binding":"INDEX","database_name":format!("{name}-index"),"database_id":m["database_id"],"migrations_dir":"../../../cloudflare/migrations"});
    for (index, suffix) in ["agent", "capture", "evaluate", "publish"]
        .iter()
        .enumerate()
    {
        let queue = json!(format!("{name}-{suffix}"));
        platform["queues"]["producers"][index]["queue"] = queue.clone();
        platform["queues"]["consumers"][index]["queue"] = queue;
        platform["queues"]["consumers"][index]["dead_letter_queue"] =
            json!(format!("{name}-dead-letter"));
    }
    let sites = json!({"$schema":"../../../node_modules/wrangler/config-schema.json","name":format!("{name}-sites"),"account_id":m["account_id"],"main":"../../../cloudflare/sites/index.ts","compatibility_date":platform["compatibility_date"],"compatibility_flags":["nodejs_compat"],"workers_dev":true,"preview_urls":false,"observability":{"enabled":true},"r2_buckets":[{"binding":"OBJECTS","bucket_name":format!("{name}-objects")}],"services":[{"binding":"PLATFORM","service":name}]});
    (platform, sites)
}
pub(crate) fn private(path: &Path, directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    Ok(())
}
pub(crate) fn wrangler(config: &Path, args: &[&str]) -> Result<()> {
    let mut all = vec!["exec", "wrangler"];
    all.extend_from_slice(args);
    all.extend(["--config", config.to_str().ok_or("Invalid config path")?]);
    run("pnpm", &all)
}
pub(crate) fn deployment(args: &[String]) -> Result<PathBuf> {
    directory(option(args, "--name")?)
}

#[cfg(test)]
#[path = "cloudflare/tests.rs"]
mod tests;
