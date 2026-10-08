use crate::process::{Result, token};
use serde_json::{Value, json};
use yoneda_core::Policy;
async fn api(url: &str, path: &str, body: Option<Value>) -> Result<Value> {
    let mut request = reqwest::Client::new()
        .request(
            if body.is_some() {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            format!("{}/api/{path}", url.trim_end_matches('/')),
        )
        .bearer_auth(token()?);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await?;
    let status = response.status();
    let value: Value = response.json().await?;
    if !status.is_success() {
        return Err(value.to_string().into());
    }
    Ok(value)
}
pub async fn seed(url: &str) -> Result<()> {
    let bootstrap = api(url, "bootstrap", Some(json!({"name":"retry-client"}))).await?;
    let commit = if let Some(commit) = bootstrap["commit"].as_str() {
        commit.to_owned()
    } else {
        let workspace =
            yoneda_runtime::export_workspace(std::path::Path::new("fixtures/retry-client"))?;
        let dir = tempfile::tempdir()?;
        let captured =
            yoneda_runtime::capture(dir.path(), None, &workspace, "Seed retry client fixture")
                .await?;
        let secret = bootstrap["token"]
            .as_str()
            .ok_or("Missing bootstrap capability")?;
        let remote = bootstrap["remote"]
            .as_str()
            .ok_or("Missing canonical remote")?;
        let status = tokio::process::Command::new("git")
            .current_dir(dir.path())
            .args(["push", remote, "HEAD:refs/heads/main"])
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.extraHeader")
            .env(
                "GIT_CONFIG_VALUE_0",
                format!("Authorization: Bearer {secret}"),
            )
            .status()
            .await?;
        if !status.success() {
            return Err("Fixture push failed".into());
        }
        captured["commit"]
            .as_str()
            .ok_or("Capture returned no commit")?
            .to_owned()
    };
    let initialized=api(url,"repos/retry-client/init",Some(json!({"id":"retry-client","name":"Retry client","remote":{"namespace":"yoneda-dev","name":"retry-client"},"commit":commit,"policy":Policy::default()}))).await;
    if let Err(error) = initialized
        && !error.to_string().contains("ALREADY_EXISTS")
    {
        return Err(error);
    }
    println!("Retry client is ready at {url}. Canonical commit: {commit}");
    Ok(())
}
pub async fn start(url: &str) -> Result<()> {
    let run=api(url,"repos/retry-client/start_run",Some(json!({"id":format!("run-{}",uuid::Uuid::new_v4()),"intent":"Add safe retries for transient upstream failures within a bounded total deadline.","criteria":["Retry GET only","Respect total deadline","Preserve explicit assumptions and tradeoffs"]}))).await?;
    println!(
        "Started real agent exploration {} at {url}. Review and select a candidate in the browser.",
        run["id"]
    );
    Ok(())
}
pub async fn verify(url: &str) -> Result<()> {
    let snapshot = api(url, "repos/retry-client/snapshot", None).await?;
    let executions = snapshot["executions"]
        .as_array()
        .ok_or("No execution records")?;
    let candidates = snapshot["candidates"].as_array().ok_or("No candidates")?;
    let published = snapshot["decisions"]
        .as_array()
        .ok_or("No decisions")?
        .iter()
        .find(|d| d["status"] == "published")
        .ok_or("No verified canonical publication yet")?;
    if !executions
        .iter()
        .any(|e| e["harness"] == "claude" && e["status"] == "completed")
        || !executions
            .iter()
            .any(|e| e["harness"] == "codex" && e["status"] == "completed")
    {
        return Err("Both harnesses must complete real executions".into());
    }
    let candidate = candidates
        .iter()
        .find(|c| c["id"] == published["candidate"])
        .ok_or("Selected source is missing")?;
    let commit = candidate["revision"]["commit"]
        .as_str()
        .ok_or("No captured commit")?;
    let path = candidate["paths"]
        .as_array()
        .and_then(|v| v.first())
        .and_then(Value::as_str)
        .ok_or("No changed source path")?;
    let why = api(
        url,
        &format!("repos/retry-client/why?commit={commit}&path={path}"),
        None,
    )
    .await?;
    if why["coverage"] != "recorded" {
        return Err("Published source has no intentional history".into());
    }
    std::fs::create_dir_all("artifacts")?;
    std::fs::write(
        "artifacts/live-verification.json",
        serde_json::to_vec_pretty(&json!({"snapshot":snapshot,"why":why}))?,
    )?;
    println!(
        "Verified both real harnesses, a captured source revision, selected evaluation, canonical publication and recorded source history. Evidence: artifacts/live-verification.json"
    );
    Ok(())
}
