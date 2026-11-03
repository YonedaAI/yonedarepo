//! Preserve declared capabilities before a regional activation can change any Worker.
use crate::deploy_plan::{Source, Step, steps};
use crate::infra::inventory::Deployable;
use crate::infra::spec::Env;
use crate::process::Result;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
pub(crate) struct Inventory {
    pub missing: BTreeSet<String>,
    /// Primary plus every declared API alias and bound authority; names only.
    pub secrets: BTreeMap<String, BTreeSet<String>>,
}

const LFS_PAIR: [&str; 2] = ["LFS_S3_ACCESS_KEY_ID", "LFS_S3_SECRET_ACCESS_KEY"];

fn declared(worker: &Deployable, name: &str) -> bool {
    worker
        .secrets
        .iter()
        .chain(&worker.optional_secrets)
        .any(|key| key == name)
}
fn source_key<'a>(worker: &'a Deployable, name: &'a str) -> &'a str {
    worker
        .secret_files
        .get(name)
        .map(String::as_str)
        .unwrap_or(name)
}
fn available(worker: &Deployable, name: &str, values: &BTreeMap<String, String>) -> bool {
    values
        .get(source_key(worker, name))
        .is_some_and(|value| !value.trim().is_empty())
}

/// Unbound authorities and frontend OAuth are outside API capability parity.
fn scope(workers: &[Deployable]) -> Vec<&Deployable> {
    let Some(primary) = workers.iter().find(|w| w.role == "platform") else {
        return Vec::new();
    };
    let participants: Vec<_> = workers
        .iter()
        .filter(|w| {
            w.role.starts_with("api-")
                || (w.role.starts_with("platform-")
                    && primary.config["services"]
                        .as_array()
                        .is_some_and(|services| {
                            services.iter().any(|service| {
                                service["binding"]
                                    .as_str()
                                    .is_some_and(|b| b.starts_with("CELL_"))
                                    && service["service"] == w.name
                            })
                        }))
        })
        .collect();
    if participants.is_empty() {
        return Vec::new();
    }
    std::iter::once(primary).chain(participants).collect()
}

fn supply(
    worker: &Deployable,
    name: &str,
    present: &BTreeSet<String>,
    values: &BTreeMap<String, String>,
    regional_lfs: bool,
) -> Result<()> {
    if !declared(worker, name) {
        return Err(format!(
            "{} does not declare active primary capability {name}",
            worker.role
        )
        .into());
    }
    if present.contains(name) {
        return Ok(());
    }
    let source = source_key(worker, name);
    if regional_lfs && source == name {
        return Err(format!(
            "{} needs an explicit regional source mapping for {name}",
            worker.role
        )
        .into());
    }
    if !available(worker, name, values) {
        return Err(format!("Refusing regional activation: {} needs {name}; declared source {source} is absent or empty",worker.role).into());
    }
    Ok(())
}

pub(crate) fn validate(
    workers: &[Deployable],
    inventory: &Inventory,
    values: &BTreeMap<String, String>,
) -> Result<()> {
    let participants = scope(workers);
    let Some(primary) = participants.first().copied() else {
        return Ok(());
    };
    for worker in &participants {
        if !inventory.secrets.contains_key(&worker.name) {
            return Err(format!(
                "Missing secret-name inventory for {}; deployment has not started",
                worker.role
            )
            .into());
        }
    }
    let mut active = inventory.secrets[&primary.name].clone();
    active.extend(
        primary
            .secrets
            .iter()
            .chain(&primary.optional_secrets)
            .filter(|name| available(primary, name, values))
            .cloned(),
    );
    let lfs_on = LFS_PAIR.iter().all(|name| active.contains(*name));
    for worker in participants {
        let present = &inventory.secrets[&worker.name];
        let authority = worker.role.starts_with("platform-");
        for name in &worker.secrets {
            supply(
                worker,
                name,
                present,
                values,
                authority && LFS_PAIR.contains(&name.as_str()),
            )?;
        }
        if worker.role == "platform" {
            continue;
        }
        let preserved: Vec<_> = if worker.role.starts_with("api-") {
            primary
                .secrets
                .iter()
                .chain(&primary.optional_secrets)
                .collect()
        } else {
            worker.optional_secrets.iter().collect()
        };
        for name in preserved {
            if (!authority || !LFS_PAIR.contains(&name.as_str())) && active.contains(name) {
                supply(worker, name, present, values, false)?;
            }
        }
        if authority && lfs_on {
            for name in LFS_PAIR {
                supply(worker, name, present, values, true)?;
            }
        }
    }
    Ok(())
}

/// Missing source files are empty sources, not permission to drop a capability.
pub(crate) fn read_sources(spec: &crate::infra::spec::Spec) -> Result<BTreeMap<String, String>> {
    match std::fs::read_to_string(spec.secrets_path()) {
        Ok(text) => Ok(crate::infra::secrets::parse(&text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(format!(
            "Cannot read declared deployment secret sources: {}",
            error.kind()
        )
        .into()),
    }
}

/// A rejected preflight returns no plan that could migrate, push or activate anything.
pub(crate) fn checked_plan(
    env: &Env,
    workers: &[Deployable],
    source: &Source,
    dry_run: bool,
    inventory: &Inventory,
    values: &BTreeMap<String, String>,
) -> Result<Vec<Step>> {
    if !dry_run {
        validate(workers, inventory, values)?;
    }
    crate::deploy_bootstrap::insert(
        steps(env, workers, dry_run, source),
        workers,
        &inventory.missing,
    )
}

#[cfg(test)]
#[path = "deploy_secret_preflight_tests.rs"]
mod tests;
