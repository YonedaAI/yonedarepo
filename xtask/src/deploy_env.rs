//! `cargo xtask deploy|rollback|status --env dev|prod|ephemeral-<id>`: one command per
//! environment, driven by `infra/envs/<env>.json` (Workers in cutover order).
use crate::deploy_guard::{self as guard, Facts, Options, short};
use crate::deploy_prebuilt::prebuilt;
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler::{self, table};
use crate::process::Result;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    BuildWasm,
    BuildFrontend,
    InstallPrebuilt,
    PushImage,
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
            Self::Migrate { .. } | Self::Secrets { .. } | Self::PushImage => true,
            Self::Deploy { dry_run, .. } => !dry_run,
            Self::BuildWasm
            | Self::BuildFrontend
            | Self::InstallPrebuilt
            | Self::ActiveGate { .. }
            | Self::Health { .. } => false,
        }
    }
}

/// The ordered plan: build (with --prebuilt: install CI's outputs locally, then push its
/// runtime image), migrate, then per Worker deploy -> secrets -> health.
pub(crate) fn steps(env: &Env, workers: &[Deployable], dry_run: bool, prebuilt: bool) -> Vec<Step> {
    let mut steps = if prebuilt {
        vec![Step::InstallPrebuilt]
    } else {
        vec![Step::BuildWasm, Step::BuildFrontend]
    };
    if prebuilt && !dry_run && workers.iter().any(|w| w.has_containers) {
        steps.push(Step::PushImage);
    }
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

/// Which deploy a command line asks for. There is no default: an env is always named.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Spec,
    Legacy,
}

pub(crate) const LEGACY_ENV: &str = "prod-legacy";

pub(crate) fn mode(args: &[String]) -> Result<Mode> {
    match args.windows(2).find(|v| v[0] == "--env").map(|v| v[1].as_str()) {
        None => Err("Usage: cargo xtask deploy --env dev|prod|ephemeral-<id> [--dry-run] [--confirm] [--allow-active] [--prebuilt <dir>]\n       cargo xtask deploy --env prod-legacy --confirm  (old single-Worker production deploy)\nRefusing: name an environment.".into()),
        Some(LEGACY_ENV) => Ok(Mode::Legacy),
        Some(_) => Ok(Mode::Spec),
    }
}

/// The legacy production deploy passes the same guards as `--env prod`.
pub(crate) async fn legacy_preflight(args: &[String]) -> Result<()> {
    let options = Options::from_args(args)?;
    if options.dry_run || options.prebuilt.is_some() {
        return Err("The legacy deploy has no dry run and no --prebuilt.".into());
    }
    let spec = Spec::load(&Env::Prod)?;
    let mut facts = guard::git_facts(&spec)?;
    prod_facts(&mut facts).await?;
    guard::preflight(&Env::Prod, &spec, &facts, &options)
}

pub(crate) async fn deploy(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let lock = Lock::load(&env)?;
    let options = Options::from_args(args)?;
    let smoke = args.iter().any(|a| a == "--agent-smoke");
    if smoke && (env != Env::Dev || options.dry_run) {
        return Err("--agent-smoke runs only after a real `deploy --env dev`.".into());
    }
    run(&env, &spec, &lock, &options).await?;
    if smoke {
        agent_smoke()?;
    }
    Ok(())
}

/// `--agent-smoke` (off by default): after the deploy, one cheap hosted agent on a fresh kit
/// project must reach a checked candidate (`tools/staging/agent-smoke.mjs`; spends real model
/// money, target under $0.01; kit credentials from ~/.config/yonedarepo).
fn agent_smoke() -> Result<()> {
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

/// Deploys `spec` with the given D1 identities (`infra up` passes the lock it just built).
pub(crate) async fn run(env: &Env, spec: &Spec, lock: &Lock, options: &Options) -> Result<()> {
    let workers = inventory::deployables(spec, lock)?;
    let mut facts = guard::git_facts(spec)?;
    if env.is_prod() {
        prod_facts(&mut facts).await?;
    }
    guard::preflight(env, spec, &facts, options)?;
    let head = facts.head.clone();
    let prebuilt = match &options.prebuilt {
        Some(dir) => Some(crate::deploy_prebuilt::check(dir, &head)?),
        None => None,
    };
    let plan = steps(env, &workers, options.dry_run, prebuilt.is_some());
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
        prebuilt: prebuilt.as_ref(),
    };
    let versions = |dry_run: bool| {
        (!dry_run)
            .then(|| crate::deploy_live::container_versions(&spec.account_id).ok())
            .flatten()
    };
    let before = versions(options.dry_run);
    let outcome = run.execute(plan, &mut summary).await;
    let after = versions(options.dry_run);
    for (index, row) in summary.iter_mut() {
        row.push(rollouts(&workers[*index], before.as_ref(), after.as_ref()));
    }
    table(
        &format!("deploy {} at {}", env.name(), short(&head)),
        &[
            "Worker",
            "Config",
            "Result",
            "/health revision",
            "Containers",
        ],
        &summary.into_values().collect::<Vec<_>>(),
    );
    outcome
}

/// Each container application with its version before and after the deploy (a new version
/// means a rollout; versions unknown in a dry run or when the listing failed).
fn rollouts(
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

struct Run<'a> {
    env: &'a Env,
    spec: &'a Spec,
    workers: &'a [Deployable],
    options: &'a Options,
    head: &'a str,
    prebuilt: Option<&'a crate::deploy_prebuilt::Prebuilt>,
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
                Step::InstallPrebuilt => prebuilt(self.prebuilt)?.install(spec)?,
                Step::PushImage => prebuilt(self.prebuilt)?.push(spec)?,
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
                    // With --prebuilt, containers deploy the pushed image from a config copy.
                    let copy = crate::deploy_prebuilt::ConfigCopy::write(self.prebuilt, w, spec)?;
                    let config = copy.as_ref().map_or(w.config_path.as_str(), |c| c.path());
                    let mut deploy = vec!["deploy", "--config", config, "--var", &revision];
                    if dry_run {
                        deploy.push("--dry-run");
                    }
                    wrangler::run(&spec.account_id, &deploy)?;
                    let state = if dry_run { "dry run" } else { "deployed" };
                    summary.insert(worker, row(w, state, "-"));
                }
                Step::Secrets { worker } => crate::deploy_secrets::ensure(spec, &workers[worker])?,
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

#[cfg(test)]
#[path = "deploy_env/tests.rs"]
mod tests;
