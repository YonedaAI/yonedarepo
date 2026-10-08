//! Trusted, reproducible starter initialization. Browsers fork this Artifacts repository.
use crate::{live::api, process::Result};
use serde_json::json;
pub(crate) async fn seed_template(url: &str) -> Result<()> {
    let name = "yoneda-website-starter";
    let bootstrap = api(url, "bootstrap", Some(json!({"name":name}))).await?;
    if let Some(commit) = bootstrap["commit"].as_str() {
        println!("Website starter already exists: {commit}");
        return Ok(());
    }
    let workspace = yoneda_runtime::export_workspace(std::path::Path::new("fixtures/website"))?;
    let root = tempfile::tempdir()?;
    let capture = yoneda_runtime::capture(
        root.path(),
        None,
        &workspace,
        "Initialize static website starter",
    )
    .await?;
    let secret = bootstrap["token"]
        .as_str()
        .ok_or("Missing initialization capability")?;
    let remote = bootstrap["remote"]
        .as_str()
        .ok_or("Missing Artifacts remote")?;
    let result = tokio::process::Command::new("git")
        .current_dir(root.path())
        .args(["push", remote, "HEAD:refs/heads/main"])
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.extraHeader")
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("Authorization: Bearer {secret}"),
        )
        .status()
        .await;
    let revoke = api(
        url,
        "bootstrap",
        Some(json!({"name":name,"revoke_token_id":bootstrap["token_id"]})),
    )
    .await;
    if !result?.success() {
        return Err("Starter push failed".into());
    }
    revoke?;
    let readback = api(url, "bootstrap", Some(json!({"name":name}))).await?;
    if readback["commit"] != capture["commit"] {
        return Err("Starter Git readback mismatch".into());
    }
    println!(
        "Website starter is ready: {}. New projects fork it without CLI setup.",
        capture["commit"]
    );
    Ok(())
}
