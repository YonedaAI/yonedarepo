//! `infra down`: delete an env's Workers and containers; with `--purge` also its queues,
//! D1, R2, workflows and Artifacts repositories. Production is refused in code.
use super::apply::snapshot;
use super::inventory::{self, Deployable};
use super::live;
use super::plan;
use super::spec::{Env, Lock, Spec};
use super::wrangler;
use crate::process::Result;
use serde_json::Value;
use std::collections::BTreeSet;

/// Down is for disposable stacks only. Production is never torn down by this tool.
pub(crate) fn down_allowed(env: &Env, confirm: bool) -> Result<()> {
    if env.is_prod() {
        return Err("Refusing: `infra down` never runs against prod.".into());
    }
    if !confirm {
        return Err(format!("Refusing to tear down {} without --confirm.", env.name()).into());
    }
    Ok(())
}

pub(crate) async fn down(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    down_allowed(&env, args.iter().any(|a| a == "--confirm"))?;
    let purge = args.iter().any(|a| a == "--purge");
    let spec = Spec::load(&env)?;
    let token = live::token(args)?;
    let live = snapshot(&spec, &token).await?;
    let lock = plan::effective_lock(&spec, &Lock::load(&env)?, &live)?;
    let workers = inventory::deployables(&spec, &lock)?;
    let mut failures = Vec::new();
    let (repos, images) = if purge {
        (
            artifacts_repos(&spec, &workers, &mut failures),
            registry_images(&spec, &workers, &mut failures),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    let mut attempt = |label: String, args: Vec<&str>| {
        if let Err(error) = wrangler::run(&spec.account_id, &args) {
            failures.push(format!("{label}: {error}"));
        }
    };
    for worker in workers
        .iter()
        .rev()
        .filter(|w| live.workers.contains_key(&w.name))
    {
        // A queue consumer blocks deleting its Worker (code 10064).
        for queue in inventory::consumers(&worker.config) {
            if live
                .queues
                .get(&queue)
                .is_some_and(|c| c.contains(&worker.name))
            {
                attempt(
                    format!("Consumer {queue}"),
                    vec!["queues", "consumer", "remove", &queue, &worker.name],
                );
            }
        }
        attempt(
            format!("Worker {}", worker.name),
            vec!["delete", &worker.name, "--force"],
        );
    }
    for (name, app) in &live.containers {
        let declared = workers
            .iter()
            .any(|w| inventory::containers(&w.config).contains_key(name));
        if let (true, Some(id)) = (declared, app["id"].as_str()) {
            attempt(
                format!("Container {name}"),
                vec!["containers", "delete", id],
            );
        }
    }
    if purge {
        for name in workers.iter().flat_map(|w| inventory::workflows(&w.config)) {
            if live.workflows.contains(&name) {
                attempt(
                    format!("Workflow {name}"),
                    vec!["workflows", "delete", &name],
                );
            }
        }
        for (namespace, repo) in &repos {
            attempt(
                format!("Artifacts {namespace}/{repo}"),
                vec![
                    "artifacts",
                    "repos",
                    "delete",
                    repo,
                    "--namespace",
                    namespace,
                    "--force",
                ],
            );
        }
        for image in &images {
            attempt(
                format!("Image {image}"),
                vec!["containers", "images", "delete", image],
            );
        }
        let mut queues = BTreeSet::new();
        let mut buckets = BTreeSet::new();
        for worker in &workers {
            queues.extend(inventory::queues(&worker.config));
            buckets.extend(inventory::r2(&worker.config));
        }
        // Dead-letter queues last: a queue cannot be deleted while it is one (code 11005).
        let dead_letters: BTreeSet<String> = workers
            .iter()
            .flat_map(|w| inventory::dead_letter_queues(&w.config))
            .collect();
        let (dead, others): (Vec<&String>, Vec<&String>) = queues
            .iter()
            .filter(|q| live.queues.contains_key(*q))
            .partition(|q| dead_letters.contains(*q));
        for queue in others.into_iter().chain(dead) {
            attempt(format!("Queue {queue}"), vec!["queues", "delete", queue]);
        }
        for database in lock.d1.keys() {
            if live.d1.contains_key(database) {
                attempt(
                    format!("D1 {database}"),
                    vec!["d1", "delete", database, "--skip-confirmation"],
                );
            }
        }
        for bucket in buckets.iter().filter(|b| live.r2.contains(*b)) {
            attempt(
                format!("R2 {bucket} (must be empty)"),
                vec!["r2", "bucket", "delete", bucket],
            );
        }
    }
    drop(attempt);
    if matches!(env, Env::Ephemeral(_)) && purge && failures.is_empty() {
        for worker in &spec.workers {
            let _ = std::fs::remove_file(
                std::path::Path::new(super::spec::CONFIG_DIR).join(&worker.file),
            );
        }
        if env.state_dir().exists() {
            std::fs::remove_dir_all(env.state_dir())?;
        }
    }
    let after = snapshot(&spec, &token).await?;
    plan::print(&env, &plan::diff(&spec, &lock, &workers, &after), &after);
    if !failures.is_empty() {
        return Err(format!(
            "{} teardown step(s) failed:\n{}",
            failures.len(),
            failures.join("\n")
        )
        .into());
    }
    if !purge {
        println!(
            "Data kept (D1, R2, queues, lock, secrets file). Durable Object state went with the deleted Workers."
        );
    }
    Ok(())
}

/// Repositories in the env's Artifacts namespaces. Namespaces themselves have no delete
/// command; an emptied one stays listed.
fn artifacts_repos(
    spec: &Spec,
    workers: &[Deployable],
    failures: &mut Vec<String>,
) -> Vec<(String, String)> {
    let namespaces: BTreeSet<String> = workers
        .iter()
        .flat_map(|w| inventory::artifacts_namespaces(&w.config))
        .collect();
    let mut repos = Vec::new();
    for namespace in namespaces {
        let listing = wrangler::output(
            &spec.account_id,
            &[
                "artifacts",
                "repos",
                "list",
                "--namespace",
                &namespace,
                "--json",
            ],
        )
        .and_then(|out| Ok(serde_json::from_slice::<Value>(&out)?));
        match listing {
            Ok(list) => repos.extend(
                list.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|r| r["name"].as_str())
                    .map(|name| (namespace.clone(), name.to_owned())),
            ),
            Err(error) => failures.push(format!("Artifacts {namespace}: {error}")),
        }
    }
    repos
}

/// `name:tag` of every registry image pushed for the env's container applications.
fn registry_images(spec: &Spec, workers: &[Deployable], failures: &mut Vec<String>) -> Vec<String> {
    let apps: BTreeSet<String> = workers
        .iter()
        .flat_map(|w| inventory::containers(&w.config).into_keys())
        .collect();
    let listing = wrangler::output(
        &spec.account_id,
        &["containers", "images", "list", "--json"],
    )
    .and_then(|out| Ok(serde_json::from_slice::<Value>(&out)?));
    let list = match listing {
        Ok(list) => list,
        Err(error) => {
            failures.push(format!("Registry images: {error}"));
            return Vec::new();
        }
    };
    let mut images = Vec::new();
    for image in list.as_array().into_iter().flatten() {
        let Some(name) = image["name"].as_str().filter(|n| apps.contains(*n)) else {
            continue;
        };
        for tag in image["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            images.push(format!("{name}:{tag}"));
        }
    }
    images
}
