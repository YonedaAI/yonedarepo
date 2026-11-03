//! `cargo xtask deploy|rollback|status --env dev|prod|ephemeral-<id>`: one command per
//! environment, driven by `infra/envs/<env>.json` (Workers in cutover order).
//!
//! Where the runtime image comes from ([`Source`]): `--prebuilt` deploys CI's tested image;
//! `--env dev` without it is the workstation deploy (deploy_image: reuse the deployed image
//! when the runtime's inputs are unchanged, else build it for linux/amd64 and push it);
//! other envs let wrangler build the Dockerfile.
use crate::deploy_exec::{Run, Timings};
use crate::deploy_guard::{self as guard, Options, short};
use crate::deploy_ledger::{Entry, Kind};
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler::table;
use crate::process::Result;
use std::collections::BTreeMap;
use std::time::Instant;

#[cfg(test)]
pub(crate) use crate::deploy_plan::steps;
pub(crate) use crate::deploy_plan::{Source, Step};

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
    let mut workers = inventory::deployables(spec, lock)?;
    if options.front_only {
        if env.is_prod() {
            return Err("--front is for dev".into());
        }
        workers.retain(|w| w.name.ends_with("-agents"));
    }
    let mut timings = Timings::default();
    let started = Instant::now();
    let mut facts = guard::git_facts(spec)?;
    if env.is_prod() {
        crate::deploy_evidence::prod_facts(&mut facts, options).await?;
    }
    guard::preflight(env, spec, &facts, options)?;
    let inventory = if !options.front_only && !options.dry_run {
        crate::deploy_cells::inventory(env, spec).await?
    } else {
        crate::deploy_secret_preflight::Inventory::default()
    };
    let values = if inventory.secrets.is_empty() {
        BTreeMap::new()
    } else {
        crate::deploy_secret_preflight::read_sources(spec)?
    };
    // Stop before builds or rollout preparation. checked_plan repeats this pure check
    // at the plan boundary; neither check uploads or rotates a credential.
    if !options.dry_run {
        crate::deploy_secret_preflight::validate(&workers, &inventory, &values)?;
    }
    timings.record("preflight: clean tree, branch tip", started, true);
    let head = facts.head.clone();
    let prebuilt = match &options.prebuilt {
        Some(dir) => {
            let checked = crate::deploy_prebuilt::check(dir, &head)?;
            checked.check_api_origin(&crate::infra::api_origin::api_origin(spec)?)?;
            Some(checked)
        }
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
    let mut plan = crate::deploy_secret_preflight::checked_plan(
        env,
        &workers,
        &source,
        options.dry_run,
        &inventory,
        &values,
    )?;
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
        rollout_started: None,
    };
    let versions = |dry_run: bool| {
        (!dry_run)
            .then(|| crate::deploy_live::container_versions(&spec.account_id).ok())
            .flatten()
    };
    let before = versions(options.dry_run);
    let outcome = run.execute(plan, &mut summary).await;
    if let Some(started_at) = run.rollout_started {
        let entry = Entry::new(env, &head, Kind::Deploy, outcome.is_ok(), started_at);
        crate::deploy_ledger::record(spec, &workers, &entry).await;
    }
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
        if let Step::Deploy { worker, .. } | Step::Bootstrap { worker, .. } = step
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
        match &step {
            Step::Deploy { worker, dry_run } => out.push(Step::DetachConsumers {
                worker: *worker,
                dry_run: *dry_run,
            }),
            Step::Bootstrap { worker, .. } => out.push(Step::DetachConsumers {
                worker: *worker,
                dry_run: false,
            }),
            _ => {}
        }
        out.push(step);
    }
    out
}

#[cfg(test)]
#[path = "deploy_env/tests.rs"]
mod tests;
