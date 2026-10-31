//! `admin search-backfill --env <env> --owner <account> --dry-run|--confirm`: queues a search
//! summary for each of one owner's repositories, through the deployed platform's
//! `POST /api/v1/admin/search-backfill`, a page at a time with a pause between pages. Each
//! repository's summary is then its own queue job. Repeating it is safe: a repository whose
//! summary is current costs its job one directory call.
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

const DEFAULT_DELAY_MS: u64 = 5000;

fn option<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let owner = option(args, "--owner").ok_or("--owner <account> is required: one at a time")?;
    let (dry_run, confirmed) = (
        args.iter().any(|a| a == "--dry-run"),
        args.iter().any(|a| a == "--confirm"),
    );
    if dry_run == confirmed {
        return Err("Pass --dry-run, or --confirm to queue".into());
    }
    let delay = match option(args, "--delay-ms") {
        Some(ms) => Duration::from_millis(ms.parse()?),
        None => Duration::from_millis(DEFAULT_DELAY_MS),
    };
    let (_, _, origin, bearer) = crate::admin::platform(&env)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    let (mut after, mut repos, mut queued) = (Value::Null, 0, 0);
    loop {
        let response = client
            .post(format!("{origin}/api/v1/admin/search-backfill"))
            .bearer_auth(&bearer)
            .json(&json!({ "owner": owner, "after": after, "dry_run": dry_run }))
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("HTTP {status}: {body}").into());
        }
        repos += body["repos"].as_u64().unwrap_or(0);
        queued += body["queued"].as_u64().unwrap_or(0);
        if body["next"].is_null() {
            break;
        }
        after = body["next"].clone();
        tokio::time::sleep(delay).await;
    }
    println!(
        "{}: {owner}: {repos} repositories, {queued} queued",
        env.name()
    );
    Ok(())
}
