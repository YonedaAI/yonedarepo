//! Trusted, reproducible starter initialization. Browsers fork this Artifacts repository.
use crate::{
    live::api_authenticated,
    process::{Result, token},
};
use serde_json::json;
pub(crate) async fn seed_template(url: &str) -> Result<()> {
    seed_template_authenticated(url, &token()?).await
}
pub(crate) async fn seed_template_authenticated(url: &str, secret: &str) -> Result<()> {
    let name = "yoneda-website-starter";
    let bootstrap = api_authenticated(url, "bootstrap", Some(json!({"name":name})), secret).await?;
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
    let capability = bootstrap["token"]
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
            format!("Authorization: Bearer {capability}"),
        )
        .status()
        .await;
    let revoke = api_authenticated(
        url,
        "bootstrap",
        Some(json!({"name":name,"revoke_token_id":bootstrap["token_id"]})),
        secret,
    )
    .await;
    if !result?.success() {
        return Err("Starter push failed".into());
    }
    revoke?;
    let readback = api_authenticated(url, "bootstrap", Some(json!({"name":name})), secret).await?;
    if readback["commit"] != capture["commit"] {
        return Err("Starter Git readback mismatch".into());
    }
    println!(
        "Website starter is ready: {}. New projects fork it without CLI setup.",
        capture["commit"]
    );
    Ok(())
}
