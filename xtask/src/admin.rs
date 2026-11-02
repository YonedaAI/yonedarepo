//! `admin backfill-accounts --env <env>`: fills the operators' account index (D1
//! `platform_accounts`) with accounts made before it, through the deployed platform's
//! `POST /api/v1/admin/backfill` as the owner (OWNER_TOKEN from the env's secrets file), one
//! page at a time until the last. Repeating it adds nothing. `admin erase-backfill` is in
//! `erase_backfill`, `admin audit-set-aside` in `audit_set_aside`,
//! `admin search-backfill` in `search_backfill`,
//! `admin revenue-rebuild` in `revenue_rebuild`, `admin internal` in `internal_accounts`,
//! `admin newsletter-export` in `newsletter_export`, `admin imports` and `admin reimport` in
//! `reimport`, `admin author-backfill` in `author_backfill`.
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    match args.get(1).map(String::as_str) {
        Some("backfill-accounts") => backfill(args).await,
        Some("audit-set-aside") => crate::audit_set_aside::execute(args).await,
        Some("erase-backfill") => crate::erase_backfill::execute(args).await,
        Some("search-backfill") => crate::search_backfill::execute(args).await,
        Some("revenue-rebuild") => crate::revenue_rebuild::execute(args).await,
        Some("internal") => crate::internal_accounts::execute(args).await,
        Some("newsletter-export") => crate::newsletter_export::execute(args).await,
        Some("imports") => crate::reimport::list(args).await,
        Some("reimport") => crate::reimport::execute(args).await,
        Some("author-backfill") => crate::author_backfill::execute(args).await,
        _ => Err(
            "cargo xtask admin backfill-accounts|audit-set-aside|erase-backfill|search-backfill|revenue-rebuild|internal|newsletter-export|imports|reimport|author-backfill --env dev|prod"
                .into(),
        ),
    }
}

/// An env's spec and Workers, its public origin and the owner's bearer.
pub(crate) fn platform(env: &Env) -> Result<(Spec, Vec<Deployable>, String, String)> {
    let spec = Spec::load(env)?;
    let workers = inventory::deployables(&spec, &Lock::load(env)?)?;
    let origin = crate::infra::smoke::front(&workers)
        .and_then(|w| w.health.as_ref().map(|(o, _)| o.clone()))
        .ok_or("No public front Worker in the spec")?;
    let owner = crate::infra::secrets::read(&spec.secrets_path())?
        .remove("OWNER_TOKEN")
        .ok_or("No OWNER_TOKEN in the secrets file")?;
    Ok((spec, workers, origin, owner))
}

/// The client for calls to a deployed platform, marked so the Traffic page leaves them out
/// (tools/own-traffic.mjs is the same mark for the Node tools).
pub(crate) fn platform_client(timeout: Duration) -> Result<reqwest::Client> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::HeaderName::from_static("x-yoneda-own-traffic"),
        reqwest::header::HeaderValue::from_static("1"),
    );
    Ok(reqwest::Client::builder()
        .timeout(timeout)
        .default_headers(headers)
        .build()?)
}

async fn backfill(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let (_, _, origin, owner) = platform(&env)?;
    let client = platform_client(Duration::from_secs(120))?;
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
