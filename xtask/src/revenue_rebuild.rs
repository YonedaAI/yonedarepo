//! `admin revenue-rebuild --env <env> --confirm`: asks every account's ledger to push all its days
//! to the revenue rollup again, through the deployed platform's `POST /api/v1/admin/revenue/rebuild`,
//! a page at a time. No money moves. It wakes every account, so it is for first use and repairs.
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    if !args.iter().any(|a| a == "--confirm") {
        return Err("Pass --confirm: this wakes every account".into());
    }
    let (_, _, origin, bearer) = crate::admin::platform(&env)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    let (mut after, mut queued) = (Value::Null, 0);
    loop {
        let response = client
            .post(format!("{origin}/api/v1/admin/revenue/rebuild"))
            .bearer_auth(&bearer)
            .json(&json!({ "after": after }))
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("HTTP {status}: {body}").into());
        }
        queued += body["queued"].as_u64().unwrap_or(0);
        if body["next"].is_null() {
            break;
        }
        after = body["next"].clone();
    }
    println!("{}: asked {queued} accounts to push again", env.name());
    Ok(())
}
