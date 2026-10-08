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
    let manifest_path = dir.join("deployment.json");
    if manifest_path.exists()
        && serde_json::from_slice::<Value>(&std::fs::read(&manifest_path)?)? != manifest
    {
        return Err(
            "Deployment identity differs from saved configuration; choose another --name".into(),
        );
    }
    let template: Value = serde_json::from_slice(&std::fs::read("wrangler.jsonc")?)?;
    let (platform, sites) = configs(template, &manifest);
    for (filename, value) in [
        ("deployment.json", manifest),
        ("platform.json", platform),
        ("sites.json", sites),
    ] {
        let path = dir.join(filename);
        // Preserve reviewed local configuration changes on repeat setup.
        if !path.exists() {
            std::fs::write(path, serde_json::to_vec_pretty(&value)?)?;
        }
    }
    println!(
        "Configuration saved in {}. Review it before deployment.",
        dir.display()
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
fn configs(mut platform: Value, m: &Value) -> (Value, Value) {
    let name = m["name"].as_str().unwrap_or_default();
    platform["name"] = m["name"].clone();
    platform["account_id"] = m["account_id"].clone();
    platform["main"] = json!("../../../worker/index.ts");
    platform["$schema"] = json!("../../../node_modules/wrangler/config-schema.json");
    platform["assets"]["directory"] = json!("../../../web/dist");
    platform["vars"]["ARTIFACTS_NAMESPACE"] = m["namespace"].clone();
    platform["vars"]["SITE_ORIGIN"] = m["sites_url"].clone();
    platform["services"][0]["service"] = m["name"].clone();
    platform
        .as_object_mut()
        .map(|p| p.remove("secrets_store_secrets"));
    platform["artifacts"][0]["namespace"] = m["namespace"].clone();
    platform["containers"][0]["image"] = json!("../../../containers/Dockerfile");
    platform["containers"][0]["image_build_context"] = json!("../../..");
    platform["r2_buckets"][0]["bucket_name"] = json!(format!("{name}-objects"));
    platform["d1_databases"][0] = json!({"binding":"INDEX","database_name":format!("{name}-index"),"database_id":m["database_id"],"migrations_dir":"../../../migrations"});
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
    let sites = json!({"$schema":"../../../node_modules/wrangler/config-schema.json","name":format!("{name}-sites"),"account_id":m["account_id"],"main":"../../../sites/index.ts","compatibility_date":platform["compatibility_date"],"compatibility_flags":["nodejs_compat"],"workers_dev":true,"preview_urls":false,"observability":{"enabled":true},"r2_buckets":[{"binding":"OBJECTS","bucket_name":format!("{name}-objects")}],"services":[{"binding":"PLATFORM","service":name}]});
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
mod tests {
    use super::*;
    #[test]
    fn portable_configuration_replaces_every_foreign_identity_and_preserves_do_history() {
        let template: Value = serde_json::from_str(include_str!("../../wrangler.jsonc")).unwrap();
        let migrations = template["migrations"].clone();
        let manifest = json!({"name":"my-platform","account_id":"a".repeat(32),"namespace":"my-namespace","database_id":"b".repeat(32),"sites_url":"https://my-platform-sites.mine.workers.dev"});
        let (platform, sites) = configs(template, &manifest);
        let text = format!("{platform}{sites}");
        for foreign in [
            "f011d0ee",
            "182c0b3e",
            "3d9115d4",
            "yoneda-dev",
            "yonedarepo-dev",
            "mlong-f01",
        ] {
            assert!(!text.contains(foreign), "retained {foreign}");
        }
        assert_eq!(platform["migrations"], migrations);
        assert_eq!(platform["d1_databases"][0]["binding"], "INDEX");
        assert_eq!(sites["services"][0]["service"], platform["name"]);
        assert!(platform.get("secrets_store_secrets").is_none());
        assert!(!slug("../prod"));
        assert!(!slug("a;curl"));
    }
}
