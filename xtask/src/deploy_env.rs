//! `cargo xtask deploy|rollback|status --env dev|prod|ephemeral-<id>`: one command per
//! environment, driven by `infra/envs/<env>.json` (Workers in cutover order).
//!
//! Where the runtime image comes from ([`Source`]): `--prebuilt` deploys CI's tested image;
//! `--env dev` without it is the workstation deploy (deploy_image: reuse the deployed image
//! when the runtime's inputs are unchanged, else build it for linux/amd64 and push it);
//! other envs let wrangler build the Dockerfile.
use crate::deploy_exec::{Run, Timings};
use crate::deploy_guard::{self as guard, Facts, Options, short};
use crate::deploy_image::ImagePlan;
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler::table;
use crate::process::Result;
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    BuildWasm,
    BuildFrontend,
    InstallPrebuilt,
    BuildImage,
    PushImage,
    RecordImage,
    Migrate { database: String, config: String },
    ActiveGate { worker: usize },
    RolloutGate,
    Deploy { worker: usize, dry_run: bool },
    Secrets { worker: usize },
    Health { worker: usize },
    Smoke,
}

impl Step {
    /// Whether the step changes anything remote (dry runs must contain none).
    pub(crate) fn mutates_remote(&self) -> bool {
        match self {
            Self::Migrate { .. } | Self::Secrets { .. } | Self::PushImage | Self::RecordImage => {
                true
            }
            Self::Deploy { dry_run, .. } => !dry_run,
            Self::BuildWasm
            | Self::BuildFrontend
            | Self::InstallPrebuilt
            | Self::BuildImage
            | Self::ActiveGate { .. }
            | Self::RolloutGate
            | Self::Health { .. }
            | Self::Smoke => false,
        }
    }
}

/// Where the container apps' runtime image comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Source {
    /// wrangler builds cloudflare/containers/Dockerfile (prod and ephemeral without --prebuilt).
    Dockerfile,
    /// `--prebuilt`: CI's tested image, pushed and recorded.
    Prebuilt,
    /// The workstation deploy of dev.
    Local(ImagePlan),
}

/// The ordered plan: build (with --prebuilt: install CI's outputs; then push and record the
/// image when there is one to push), migrate, then per Worker deploy -> secrets -> health.
/// A workstation deploy builds its image only when it cannot reuse one, checks busy
/// containers right before the first rollout (and before a slow build), and ends with the
/// smoke.
pub(crate) fn steps(
    env: &Env,
    workers: &[Deployable],
    dry_run: bool,
    source: &Source,
) -> Vec<Step> {
    let containers = workers.iter().any(|w| w.has_containers);
    let mut steps = match source {
        Source::Prebuilt => vec![Step::InstallPrebuilt],
        Source::Dockerfile | Source::Local(_) => vec![Step::BuildWasm, Step::BuildFrontend],
    };
    if containers && !dry_run {
        match source {
            Source::Prebuilt => steps.extend([Step::PushImage, Step::RecordImage]),
            Source::Local(ImagePlan::Build { .. }) => steps.extend([
                Step::RolloutGate,
                Step::BuildImage,
                Step::PushImage,
                Step::RecordImage,
            ]),
            Source::Local(ImagePlan::Reuse { .. }) | Source::Dockerfile => {}
        }
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
    let mut rollout_pending = matches!(source, Source::Local(plan) if !plan.rollouts().is_empty());
    for (index, worker) in workers.iter().enumerate() {
        if env.is_prod() && worker.has_containers {
            steps.push(Step::ActiveGate { worker: index });
        }
        if rollout_pending && worker.has_containers {
            steps.push(Step::RolloutGate);
            rollout_pending = false;
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
    if !dry_run && matches!(source, Source::Local(_)) {
        steps.push(Step::Smoke);
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
    let mut timings = Timings::default();
    let started = Instant::now();
    let mut facts = guard::git_facts(spec)?;
    if env.is_prod() {
        prod_facts(&mut facts).await?;
    }
    guard::preflight(env, spec, &facts, options)?;
    timings.record("preflight: clean tree, branch tip", started, true);
    let head = facts.head.clone();
    let prebuilt = match &options.prebuilt {
        Some(dir) => Some(crate::deploy_prebuilt::check(dir, &head)?),
        None => None,
    };
    let (source, image, inputs) = match (&prebuilt, env) {
        (Some(p), _) => (Source::Prebuilt, Some(p.image_ref(spec)), None),
        (None, Env::Dev) => {
            let started = Instant::now();
            let local = crate::deploy_image::local_image(env, spec, &workers, &head);
            timings.record("image decision", started, local.is_ok());
            let (plan, image, inputs) = local.inspect_err(|_| timings.print())?;
            (Source::Local(plan), image, Some(inputs))
        }
        (None, _) => (Source::Dockerfile, None, None),
    };
    let plan = steps(env, &workers, options.dry_run, &source);
    if options.dry_run && plan.iter().any(Step::mutates_remote) {
        return Err("Internal error: the dry-run plan contains a remote change".into());
    }
    let mut summary: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let mut run = Run {
        env,
        spec,
        workers: &workers,
        options,
        head: &head,
        prebuilt: prebuilt.as_ref(),
        image,
        inputs,
        timings,
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
    run.timings.print();
    outcome
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

#[cfg(test)]
#[path = "deploy_env/tests.rs"]
mod tests;
