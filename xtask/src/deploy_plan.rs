//! Pure build, migration and rollout steps shared by deployment and bootstrap tests.
use crate::deploy_image::ImagePlan;
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::Env;
use std::collections::BTreeSet;

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
    Bootstrap {
        worker: usize,
        config: serde_json::Value,
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
            | Self::MoveHosts { .. }
            | Self::Bootstrap { .. } => true,
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
        if !dry_run && !(worker.secrets.is_empty() && worker.optional_secrets.is_empty()) {
            steps.push(Step::Secrets { worker: index });
        }
        if !dry_run && worker.health.is_some() {
            steps.push(Step::Health { worker: index });
        }
    }
    // The smoke reads every Worker; a front-only deploy leaves the rest on their revision.
    if !dry_run && matches!(source, Source::Local(_)) && workers.len() > 1 {
        steps.push(Step::Smoke);
    }
    steps
}
