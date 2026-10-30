//! `admin backfill-accounts --env <env>`: fills the operators' account index (D1
//! `platform_accounts`) with accounts made before it, through the deployed platform's
//! `POST /api/v1/admin/backfill` as the owner (OWNER_TOKEN from the env's secrets file), one
//! page at a time until the last. Repeating it adds nothing.
use crate::infra::inventory;
use crate::infra::spec::{Env, Lock, Spec};
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    match args.get(1).map(String::as_str) {
        Some("backfill-accounts") => backfill(args).await,
        _ => Err("cargo xtask admin backfill-accounts --env dev|prod".into()),
    }
}

async fn backfill(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let workers = inventory::deployables(&spec, &Lock::load(&env)?)?;
    let origin = crate::infra::smoke::front(&workers)
        .and_then(|w| w.health.as_ref().map(|(o, _)| o.clone()))
        .ok_or("No public front Worker in the spec")?;
    let owner = crate::infra::secrets::read(&spec.secrets_path())?
        .remove("OWNER_TOKEN")
        .ok_or("No OWNER_TOKEN in the secrets file")?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()?;
    let (mut after, mut scanned, mut added) = (String::new(), 0, 0);
    loop {
        let response = client
            .post(format!("{origin}/api/v1/admin/backfill"))
            .bearer_auth(&owner)
            .json(&json!({ "after": after }))
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("backfill at {after:?}: HTTP {status}: {body}").into());
        }
        scanned += body["scanned"].as_u64().unwrap_or(0);
        added += body["added"].as_u64().unwrap_or(0);
        match body["next"].as_str() {
            Some(next) => after = next.to_owned(),
            None => break,
        }
    }
    println!(
        "{}: scanned {scanned} known accounts, added {added} to the index",
        env.name()
    );
    Ok(())
}
