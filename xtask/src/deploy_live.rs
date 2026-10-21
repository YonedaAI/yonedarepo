//! Live state of a deployed environment: `/health` revisions, busy containers, and the
//! `rollback` / `status` commands.
use crate::deploy_guard::{self as guard, Options, short};
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler::{self, table};
use crate::process::Result;
use serde_json::Value;
use std::time::Duration;

pub(crate) async fn live_revision(worker: &Deployable) -> Option<String> {
    let (origin, service) = worker.health.as_ref()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let body: Value = client
        .get(format!("{origin}/health"))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json()
        .await
        .ok()?;
    (body["service"] == service.as_str())
        .then(|| body["revision"].as_str().map(str::to_owned))
        .flatten()
}

/// New code can take a few seconds to reach every colo; poll for up to a minute.
pub(crate) async fn wait_for_revision(worker: &Deployable, head: &str) -> Option<String> {
    let mut live = None;
    for _ in 0..12 {
        live = live_revision(worker).await;
        if live.as_deref() == Some(head) {
            break;
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    live
}

/// Container application name -> its current version (a rollout bumps it).
pub(crate) fn container_versions(
    account_id: &str,
) -> Result<std::collections::BTreeMap<String, u64>> {
    let apps: Value = serde_json::from_slice(&wrangler::output(
        account_id,
        &["containers", "list", "--json", "--per-page", "100"],
    )?)?;
    Ok(apps
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["name"].as_str()?.to_owned(), a["version"].as_u64()?)))
        .collect())
}

/// Busy instances (active, assigned, starting or scheduling) of the Worker's containers.
pub(crate) fn active_instances(account_id: &str, config: &Value) -> Result<u64> {
    let declared = inventory::containers(config);
    let apps: Value = serde_json::from_slice(&wrangler::output(
        account_id,
        &["containers", "list", "--json", "--per-page", "100"],
    )?)?;
    let mut busy = 0;
    for app in apps.as_array().into_iter().flatten() {
        let (Some(name), Some(id)) = (app["name"].as_str(), app["id"].as_str()) else {
            continue;
        };
        if !declared.contains_key(name) {
            continue;
        }
        let info: Value = serde_json::from_slice(&wrangler::output(
            account_id,
            &["containers", "info", id, "--json"],
        )?)?;
        let counts = &info["health"]["instances"];
        busy += ["active", "assigned", "starting", "scheduling"]
            .iter()
            .map(|k| counts[*k].as_u64().unwrap_or(0))
            .sum::<u64>();
    }
    Ok(busy)
}

pub(crate) async fn rollback(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let options = Options::from_args(args)?;
    if env.is_prod() && !options.confirm {
        return Err("Refusing to roll back prod without --confirm.".into());
    }
    let spec = Spec::load(&env)?;
    let workers = inventory::deployables(&spec, &Lock::load(&env)?)?;
    let message = format!("cargo xtask rollback --env {}", env.name());
    for worker in workers.iter().rev() {
        if env.is_prod() && worker.has_containers {
            let active = active_instances(&spec.account_id, &worker.config)?;
            guard::active_gate(&env, &worker.name, active, &options)?;
        }
        if options.dry_run {
            println!(
                "Dry run: would roll back {} to its previous deployment.",
                worker.name
            );
            continue;
        }
        wrangler::run(
            &spec.account_id,
            &[
                "rollback",
                "--name",
                &worker.name,
                "--message",
                &message,
                "--yes",
            ],
        )?;
    }
    status_table(&env, &workers).await
}

pub(crate) async fn status(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let workers = inventory::deployables(&spec, &Lock::load(&env)?)?;
    status_table(&env, &workers).await
}

async fn status_table(env: &Env, workers: &[Deployable]) -> Result<()> {
    let head = guard::head()?;
    let mut rows = Vec::new();
    for worker in workers {
        let live = match worker.health {
            Some(_) => live_revision(worker)
                .await
                .unwrap_or_else(|| "unreachable".into()),
            None => "no /health".into(),
        };
        let matches = if live == head {
            "yes"
        } else if worker.health.is_some() {
            "NO"
        } else {
            "-"
        };
        let routes: Vec<String> = inventory::routes(&worker.config)
            .into_iter()
            .map(|r| {
                if r.custom_domain {
                    format!("{} (domain)", r.pattern)
                } else {
                    r.pattern
                }
            })
            .collect();
        rows.push(vec![
            worker.name.clone(),
            short(&live).to_owned(),
            matches.into(),
            if routes.is_empty() {
                "workers.dev".into()
            } else {
                routes.join(", ")
            },
        ]);
    }
    table(
        &format!("{} vs local HEAD {}", env.name(), short(&head)),
        &["Worker", "Live revision", "= HEAD", "Routes"],
        &rows,
    );
    Ok(())
}
