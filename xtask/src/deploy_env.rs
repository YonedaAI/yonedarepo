//! `cargo xtask deploy|rollback|status --env dev|prod|ephemeral-<id>`: one command per
//! environment, driven by `infra/envs/<env>.json` (Workers in cutover order).
use crate::deploy_guard::{self as guard, Facts, Options, short};
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler::{self, table};
use crate::process::Result;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    BuildWasm,
    BuildFrontend,
    Migrate { database: String, config: String },
    ActiveGate { worker: usize },
    Deploy { worker: usize, dry_run: bool },
    Secrets { worker: usize },
    Health { worker: usize },
}

impl Step {
    /// Whether the step changes anything remote (dry runs must contain none).
    pub(crate) fn mutates_remote(&self) -> bool {
        match self {
            Self::Migrate { .. } | Self::Secrets { .. } => true,
            Self::Deploy { dry_run, .. } => !dry_run,
            Self::BuildWasm
            | Self::BuildFrontend
            | Self::ActiveGate { .. }
            | Self::Health { .. } => false,
        }
    }
}

/// The ordered plan: build, migrate, then per Worker deploy -> secrets -> health.
pub(crate) fn steps(env: &Env, workers: &[Deployable], dry_run: bool) -> Vec<Step> {
    let mut steps = vec![Step::BuildWasm, Step::BuildFrontend];
    if !dry_run {
        let mut seen = BTreeSet::new();
        for worker in workers {
            for (database, dir) in inventory::d1(&worker.config) {
                if dir.is_some() && seen.insert(database.clone()) {
                    steps.push(Step::Migrate {
                        database,
                        config: worker.config_path.clone(),
                    });
                }
            }
        }
    }
    for (index, worker) in workers.iter().enumerate() {
        if env.is_prod() && worker.has_containers {
            steps.push(Step::ActiveGate { worker: index });
        }
        steps.push(Step::Deploy {
            worker: index,
            dry_run,
        });
        if !dry_run && !worker.secrets.is_empty() {
            steps.push(Step::Secrets { worker: index });
        }
        if !dry_run && worker.health.is_some() {
            steps.push(Step::Health { worker: index });
        }
    }
    steps
}

pub(crate) async fn deploy(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let lock = Lock::load(&env)?;
    run(&env, &spec, &lock, &Options::from_args(args)).await
}

/// Deploys `spec` with the given D1 identities (`infra up` passes the lock it just built).
pub(crate) async fn run(env: &Env, spec: &Spec, lock: &Lock, options: &Options) -> Result<()> {
    let workers = inventory::deployables(spec, lock)?;
    let mut facts = guard::git_facts(spec)?;
    if env.is_prod() {
        prod_facts(&mut facts).await?;
    }
    guard::preflight(env, spec, &facts, options)?;
    let head = facts.head.clone();
    let plan = steps(env, &workers, options.dry_run);
    if options.dry_run && plan.iter().any(Step::mutates_remote) {
        return Err("Internal error: the dry-run plan contains a remote change".into());
    }
    let mut summary: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let run = Run {
        env,
        spec,
        workers: &workers,
        options,
        head: &head,
    };
    let outcome = run.execute(plan, &mut summary).await;
    println!("\n{} at {}:", env.name(), short(&head));
    table(
        &["Worker", "Config", "Result", "/health revision"],
        &summary.into_values().collect::<Vec<_>>(),
    );
    outcome
}

struct Run<'a> {
    env: &'a Env,
    spec: &'a Spec,
    workers: &'a [Deployable],
    options: &'a Options,
    head: &'a str,
}

impl Run<'_> {
    /// Executes the plan in order; the first failure stops it. `summary` keeps what ran.
    async fn execute(
        &self,
        plan: Vec<Step>,
        summary: &mut BTreeMap<usize, Vec<String>>,
    ) -> Result<()> {
        let (env, spec, workers, options, head) =
            (self.env, self.spec, self.workers, self.options, self.head);
        for step in plan {
            match step {
                Step::BuildWasm => crate::commands::build_wasm()?,
                Step::BuildFrontend => frontend_build()?,
                Step::Migrate { database, config } => wrangler::run(
                    &spec.account_id,
                    &[
                        "d1",
                        "migrations",
                        "apply",
                        &database,
                        "--remote",
                        "--config",
                        &config,
                    ],
                )?,
                Step::ActiveGate { worker } => {
                    let active = crate::deploy_live::active_instances(
                        &spec.account_id,
                        &workers[worker].config,
                    )?;
                    guard::active_gate(env, &workers[worker].name, active, options)?;
                }
                Step::Deploy { worker, dry_run } => {
                    let w = &workers[worker];
                    let revision = format!("BUILD_REVISION:{head}");
                    let mut deploy = vec!["deploy", "--config", &w.config_path, "--var", &revision];
                    if dry_run {
                        deploy.push("--dry-run");
                    }
                    wrangler::run(&spec.account_id, &deploy)?;
                    let state = if dry_run { "dry run" } else { "deployed" };
                    summary.insert(worker, row(w, state, "-"));
                }
                Step::Secrets { worker } => ensure_secrets(spec, &workers[worker])?,
                Step::Health { worker } => {
                    let w = &workers[worker];
                    let live = crate::deploy_live::wait_for_revision(w, head).await;
                    if let Some(row) = summary.get_mut(&worker) {
                        row[3] = live.clone().unwrap_or_else(|| "unreachable".into());
                    }
                    guard::revision_gate(&w.name, head, live.as_deref())?;
                }
            }
        }
        Ok(())
    }
}

fn row(w: &Deployable, state: &str, revision: &str) -> Vec<String> {
    vec![
        w.name.clone(),
        w.config_path.clone(),
        state.into(),
        revision.into(),
    ]
}

async fn prod_facts(facts: &mut Facts) -> Result<()> {
    let dev = Spec::load(&Env::Dev)?;
    for worker in inventory::deployables(&dev, &Lock::load(&Env::Dev)?)? {
        if worker.health.is_some() {
            facts.dev_revisions.push((
                worker.name.clone(),
                crate::deploy_live::live_revision(&worker).await,
            ));
        }
    }
    facts.evidence = guard::newest_evidence(std::path::Path::new(guard::EVIDENCE_DIR))?;
    Ok(())
}

/// Builds the frontend without pnpm (worktrees symlink node_modules).
pub(crate) fn frontend_build() -> Result<()> {
    for (program, args) in [
        ("node_modules/.bin/tsc", vec!["-b"]),
        ("node_modules/.bin/vite", vec!["build"]),
    ] {
        let status = std::process::Command::new(program)
            .args(&args)
            .current_dir(crate::layout::FRONTEND)
            .status()
            .map_err(|error| format!("Cannot start frontend {program}: {error}"))?;
        if !status.success() {
            return Err(format!("Frontend {program} failed ({status})").into());
        }
    }
    Ok(())
}

/// Uploads only the declared secrets the Worker lacks; existing values are never rotated.
fn ensure_secrets(spec: &Spec, worker: &Deployable) -> Result<()> {
    let listing = wrangler::output(
        &spec.account_id,
        &[
            "secret",
            "list",
            "--format",
            "json",
            "--config",
            &worker.config_path,
        ],
    )?;
    let present: BTreeSet<String> = serde_json::from_slice::<Value>(&listing)?
        .as_array()
        .ok_or("Unexpected secret inventory; refusing changes")?
        .iter()
        .filter_map(|s| s["name"].as_str().map(str::to_owned))
        .collect();
    let missing: Vec<&String> = worker
        .secrets
        .iter()
        .filter(|s| !present.contains(*s))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let values = crate::infra::secrets::read(&spec.secrets_path())?;
    let mut upload = serde_json::Map::new();
    for name in missing {
        let value = values.get(name).ok_or_else(|| {
            format!(
                "{name} is missing on {} and in {}",
                worker.name, spec.secrets_file
            )
        })?;
        upload.insert(name.clone(), Value::String(value.clone()));
    }
    wrangler::run_with_stdin(
        &spec.account_id,
        &["secret", "bulk", "--config", &worker.config_path],
        &serde_json::to_vec(&upload)?,
    )
}

#[cfg(test)]
#[path = "deploy_env/tests.rs"]
mod tests;
