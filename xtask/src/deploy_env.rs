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
    Migrate {
        database: String,
        config: String,
    },
    ActiveGate {
        worker: usize,
    },
    /// Prod: busy instances of the container apps the spec's `retired` Workers left behind
    /// (the cutover takes their hosts, so their runs end too).
    RetiredGate,
    RolloutGate,
    /// `infra up`: detach the Worker's hosts from whichever other Worker holds them.
    MoveHosts {
        worker: usize,
    },
    /// Detach the live Worker's queue consumers its new config no longer declares (a dry
    /// run only lists them).
    DetachConsumers {
        worker: usize,
        dry_run: bool,
    },
    Deploy {
        worker: usize,
        dry_run: bool,
    },
    Secrets {
        worker: usize,
    },
    Health {
        worker: usize,
    },
    Smoke,
}

impl Step {
    /// Whether the step changes anything remote (dry runs must contain none).
    pub(crate) fn mutates_remote(&self) -> bool {
        match self {
            Self::Migrate { .. }
            | Self::Secrets { .. }
            | Self::PushImage
            | Self::RecordImage
            | Self::MoveHosts { .. } => true,
            Self::Deploy { dry_run, .. } | Self::DetachConsumers { dry_run, .. } => !dry_run,
            Self::BuildWasm
            | Self::BuildFrontend
            | Self::InstallPrebuilt
            | Self::BuildImage
            | Self::ActiveGate { .. }
            | Self::RetiredGate
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
    if env.is_prod() {
        steps.push(Step::RetiredGate);
    }
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

pub(crate) async fn deploy(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let lock = Lock::load(&env)?;
    let options = Options::from_args(args)?;
    run(&env, &spec, &lock, &options, None).await
}

/// Deploys `spec` with the given D1 identities (`infra up` passes the lock it just built).
/// With `host_token` (`infra up`), each Worker's hosts are first detached from any other
/// Worker that holds them.
pub(crate) async fn run(
    env: &Env,
    spec: &Spec,
    lock: &Lock,
    options: &Options,
    host_token: Option<&str>,
) -> Result<()> {
    guard::refuse_pending(env, lock)?;
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
    let mut plan = steps(env, &workers, options.dry_run, &source);
    if host_token.is_some() && !options.dry_run {
        plan = with_host_moves(plan, &workers);
    }
    plan = with_consumer_detach(plan);
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
        host_token,
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
        row.push(crate::deploy_live::rollouts(
            &workers[*index],
            before.as_ref(),
            after.as_ref(),
        ));
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

/// Inserts a host move right before the deploy of every Worker that declares routes.
pub(crate) fn with_host_moves(plan: Vec<Step>, workers: &[Deployable]) -> Vec<Step> {
    let mut out = Vec::with_capacity(plan.len() + workers.len());
    for step in plan {
        if let Step::Deploy { worker, .. } = step
            && !inventory::routes(&workers[worker].config).is_empty()
        {
            out.push(Step::MoveHosts { worker });
        }
        out.push(step);
    }
    out
}

/// Inserts a stale-consumer detach right before every Worker deploy (after its host move).
pub(crate) fn with_consumer_detach(plan: Vec<Step>) -> Vec<Step> {
    let mut out = Vec::with_capacity(plan.len() * 2);
    for step in plan {
        if let Step::Deploy { worker, dry_run } = step {
            out.push(Step::DetachConsumers { worker, dry_run });
        }
        out.push(step);
    }
    out
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
