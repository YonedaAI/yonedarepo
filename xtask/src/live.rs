use crate::process::{Result, token};
use serde_json::{Value, json};
use yoneda_core::Policy;
pub(crate) async fn api(url: &str, path: &str, body: Option<Value>) -> Result<Value> {
    api_authenticated(url, path, body, &token()?).await
}
pub(crate) async fn api_authenticated(
    url: &str,
    path: &str,
    body: Option<Value>,
    secret: &str,
) -> Result<Value> {
    let mut request = reqwest::Client::new()
        .request(
            if body.is_some() {
                reqwest::Method::POST
            } else {
                reqwest::Method::GET
            },
            format!("{}/api/{path}", url.trim_end_matches('/')),
        )
        .bearer_auth(secret);
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
    let run=api(url,"repos/retry-client/start_run",Some(json!({"id":format!("run-{}",uuid::Uuid::new_v4()),"intent":"Add safe retries for transient upstream failures within a bounded total deadline.","criteria":["Retry GET only","Respect total deadline","Read README.md before publishing guidance; preserve its CLI contract, including repeating the final supplied status when the status list is exhausted","Preserve explicit assumptions and tradeoffs"]}))).await?;
    println!(
        "Started real agent exploration {} at {url}. Review and select a candidate in the browser.",
        run["id"]
    );
    Ok(())
}
pub async fn verify(url: &str) -> Result<()> {
    let snapshot = api(url, "repos/retry-client/snapshot", None).await?;
    let mut events = Vec::new();
    let mut after = 0;
    loop {
        let page = api(
            url,
            &format!("repos/retry-client/events?after={after}"),
            None,
        )
        .await?;
        let page = page["events"].as_array().ok_or("No event replay")?;
        if page.is_empty() {
            break;
        }
        after = page
            .last()
            .and_then(|e| e["seq"].as_u64())
            .ok_or("Invalid event sequence")?;
        events.extend(page.iter().cloned());
        if after >= snapshot["seq"].as_u64().unwrap_or(0) {
            break;
        }
    }
    let mut why = json!({"coverage":"unknown","nodes":[],"edges":[]});
    if let Ok((_, candidate)) = crate::verification::selected(&snapshot)
        && let (Some(commit), Some(path)) = (
            candidate["revision"]["commit"].as_str(),
            candidate["paths"]
                .as_array()
                .and_then(|v| v.first())
                .and_then(Value::as_str),
        )
    {
        let query = reqwest::Url::parse_with_params(
            "https://query.invalid/",
            [("commit", commit), ("path", path)],
        )?;
        why = api(
            url,
            &format!(
                "repos/retry-client/why?{}",
                query.query().unwrap_or_default()
            ),
            None,
        )
        .await?;
    }
    let result = crate::verification::check(&snapshot, &events, &why);
    std::fs::create_dir_all("artifacts")?;
    std::fs::write(
        "artifacts/live-verification.json",
        serde_json::to_vec_pretty(
            &json!({"verification":{"complete":result.is_ok(),"error":result.as_ref().err().map(ToString::to_string)},"snapshot":snapshot,"events":events,"why":why}),
        )?,
    )?;
    result?;
    println!(
        "Verified one complete run: research, three overlapping coding harnesses, shared context, exact captured/evaluated revisions, canonical publication and simulated incident history. Recorded owner selection is not a claim of user approval. Evidence: artifacts/live-verification.json"
    );
    Ok(())
}

pub async fn upgrade_policy(url: &str) -> Result<()> {
    let snapshot = api(url, "repos/retry-client/snapshot", None).await?;
    let repo = &snapshot["repository"];
    api(url,"repos/retry-client/update_policy",Some(json!({"expected_commit":repo["head_commit"],"expected_version":repo["version"],"expected_policy":repo["policy"]["version"],"policy":Policy::default()}))).await?;
    println!(
        "Installed current versioned policy; captured candidates will be evaluated again. Historical evidence is retained."
    );
    Ok(())
}
