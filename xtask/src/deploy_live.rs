//! Live state of a deployed environment: `/health` revisions, busy containers, and the
//! `rollback` / `status` commands.
use crate::deploy_guard::{self as guard, Options, short};
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler::{self, table};
use crate::process::Result;
use serde_json::Value;
use std::collections::BTreeMap;
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
pub(crate) fn container_versions(account_id: &str) -> Result<BTreeMap<String, u64>> {
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
    Ok(busy_instances(account_id, config)?
        .iter()
        .map(|(_, count)| count)
        .sum())
}

/// Each declared container application of the Worker with its busy instance count.
pub(crate) fn busy_instances(account_id: &str, config: &Value) -> Result<Vec<(String, u64)>> {
    let declared = inventory::containers(config);
    busy_apps(account_id, |name| declared.contains_key(name))
}

/// Busy instances (active, assigned, starting or scheduling) of every container application
/// whose name `wanted` accepts.
pub(crate) fn busy_apps(
    account_id: &str,
    wanted: impl Fn(&str) -> bool,
) -> Result<Vec<(String, u64)>> {
    let apps: Value = serde_json::from_slice(&wrangler::output(
        account_id,
        &["containers", "list", "--json", "--per-page", "100"],
    )?)?;
    let mut busy = Vec::new();
    for app in apps.as_array().into_iter().flatten() {
        let (Some(name), Some(id)) = (app["name"].as_str(), app["id"].as_str()) else {
            continue;
        };
        if !wanted(name) {
            continue;
        }
        let info: Value = serde_json::from_slice(&wrangler::output(
            account_id,
            &["containers", "info", id, "--json"],
        )?)?;
        let counts = &info["health"]["instances"];
        let count = ["active", "assigned", "starting", "scheduling"]
            .iter()
            .map(|k| counts[*k].as_u64().unwrap_or(0))
            .sum::<u64>();
        busy.push((name.to_owned(), count));
    }
    Ok(busy)
}

/// `cargo xtask live-check --env <env>`: CI's dev deploy job asks whether this commit is
/// already live. Writes `deploy=true|false` to `$GITHUB_OUTPUT` (and the skip line to the job
/// summary). An unreachable `/health` means deploy: the deploy's own guards then decide.
pub(crate) async fn live_check(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let head = guard::head()?;
    let mut revisions = Vec::new();
    for worker in inventory::deployables(&spec, &Lock::load(&env)?)? {
        if worker.health.is_some() {
            revisions.push((worker.name.clone(), live_revision(&worker).await));
        }
    }
    let (deploy, line) = match guard::live_check(&head, &revisions) {
        guard::LiveCheck::Skip(line) => (false, line),
        guard::LiveCheck::Deploy(line) => (true, line),
    };
    println!("{line}");
    append_env_file("GITHUB_OUTPUT", &format!("deploy={deploy}\n"))?;
    if !deploy {
        append_env_file(
            "GITHUB_STEP_SUMMARY",
            &format!("### Deploy dev\n\n{line}\n\n"),
        )?;
    }
    Ok(())
}

/// Appends to the file a GitHub Actions variable names; nothing outside Actions.
fn append_env_file(var: &str, text: &str) -> Result<()> {
    if let Some(path) = std::env::var_os(var) {
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(path)?
            .write_all(text.as_bytes())?;
    }
    Ok(())
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

/// `--agent-smoke` (off by default): after the deploy, one cheap hosted agent on a fresh kit
/// project must reach a checked candidate (`tools/staging/agent-smoke.mjs`; spends real model
/// money, target under $0.01; kit credentials from ~/.config/yonedarepo).
pub(crate) fn agent_smoke() -> Result<()> {
    let status = std::process::Command::new("node")
        .args(["tools/staging-realworld.mjs", "--agent-smoke"])
        .status()
        .map_err(|error| format!("Cannot start the agent smoke: {error}"))?;
    if status.success() {
        println!("AGENT SMOKE: PASS");
        Ok(())
    } else {
        println!("AGENT SMOKE: FAIL ({status})");
        Err("The deploy finished but the agent smoke failed; see its output above.".into())
    }
}

/// Each container application with its version before and after the deploy (a new version
/// means a rollout; versions unknown in a dry run or when the listing failed).
pub(crate) fn rollouts(
    worker: &Deployable,
    before: Option<&BTreeMap<String, u64>>,
    after: Option<&BTreeMap<String, u64>>,
) -> String {
    let apps: Vec<String> = inventory::containers(&worker.config)
        .into_keys()
        .map(|app| {
            let version = |map: Option<&BTreeMap<String, u64>>| {
                map.and_then(|m| m.get(&app))
                    .map_or("?".to_owned(), |v| format!("v{v}"))
            };
            match (version(before), version(after)) {
                (b, a) if b == a => format!("{app} {a} (no rollout)"),
                (b, a) => format!("{app} {b} -> {a} (rolled out)"),
            }
        })
        .collect();
    if apps.is_empty() {
        "-".into()
    } else {
        apps.join("; ")
    }
}
