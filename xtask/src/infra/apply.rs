//! `infra up` (idempotent create -> lock -> generate -> deploy) and `infra down`.
use super::live::{self, Live};
use super::plan::{self, Action};
use super::spec::{Env, Lock, Spec};
use super::{generate, inventory, secrets, wrangler};
use crate::process::Result;

/// Placeholder D1 id for dry runs of an env whose databases do not exist yet.
const DRY_RUN_D1: &str = "00000000-0000-4000-8000-000000000000";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Create {
    D1(String),
    R2(String),
    Queue(String),
}

/// Resources a plan says to create that only exist once created explicitly. Workers,
/// routes, domains, workflows, containers and secrets come with the deploy.
pub(crate) fn creations(rows: &[plan::Row]) -> Vec<Create> {
    rows.iter()
        .filter(|r| r.action == Action::Create)
        .filter_map(|r| match r.kind {
            "d1" => Some(Create::D1(r.name.clone())),
            "r2" => Some(Create::R2(r.name.clone())),
            "queue" => Some(Create::Queue(r.name.clone())),
            _ => None,
        })
        .collect()
}

pub(crate) async fn snapshot(spec: &Spec, token: &str) -> Result<Live> {
    let live = live::read(spec, token.to_owned(), &spec.worker_names()?).await;
    Ok(live)
}

pub(crate) async fn up(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let dry_run = args.iter().any(|a| a == "--dry-run");
    if env.is_prod() && !args.iter().any(|a| a == "--confirm") {
        return Err("Refusing to apply prod without --confirm.".into());
    }
    let spec = Spec::load(&env)?;
    let token = live::token(args)?;
    let recorded = Lock::load(&env)?;
    let live = snapshot(&spec, &token).await?;
    if !live.errors.is_empty() {
        return Err(format!(
            "Cannot read live state, so nothing was changed: {}",
            live.errors.join("; ")
        )
        .into());
    }
    if matches!(env, Env::Ephemeral(_))
        && !dry_run
        && secrets::ensure_generated(&spec.secrets_path())?
    {
        println!("Generated {} (0600).", spec.secrets_path().display());
    }
    let workers = inventory::deployables(&spec, &plan::effective_lock(&spec, &recorded, &live)?)?;
    let todo = creations(&plan::diff(&spec, &recorded, &workers, &live));
    for item in &todo {
        let args: Vec<&str> = match item {
            Create::D1(name) => vec!["d1", "create", name],
            Create::R2(name) => vec!["r2", "bucket", "create", name],
            Create::Queue(name) => vec!["queues", "create", name],
        };
        if dry_run {
            println!("Dry run: would run wrangler {}", args.join(" "));
        } else {
            wrangler::run(&spec.account_id, &args)?;
        }
    }
    let live = if todo.is_empty() || dry_run {
        live
    } else {
        snapshot(&spec, &token).await?
    };
    let mut lock = plan::effective_lock(&spec, &recorded, &live)?;
    for (name, id) in lock.d1.iter_mut() {
        if id.is_empty() {
            if !dry_run {
                return Err(format!("D1 {name} still does not exist after creation").into());
            }
            *id = DRY_RUN_D1.into();
        }
    }
    if lock != recorded && !dry_run {
        lock.save(&env)?;
        println!("Recorded D1 ids in {}.", env.lock_path().display());
    }
    let generated = generate::generate(
        &env,
        &spec,
        &lock,
        dry_run && !matches!(env, Env::Ephemeral(_)),
    )?;
    let changed: Vec<String> = generated
        .iter()
        .filter(|(_, c)| *c)
        .map(|(p, _)| p.display().to_string())
        .collect();
    if !matches!(env, Env::Ephemeral(_)) && (!changed.is_empty() || lock != recorded) && !dry_run {
        return Err(format!(
            "The spec changed tracked files ({}). Review and commit them, then rerun `cargo xtask infra up --env {}`.",
            changed.join(", "),
            env.name()
        )
        .into());
    }
    if dry_run
        && matches!(env, Env::Ephemeral(_))
        && todo.iter().any(|c| matches!(c, Create::D1(_)))
    {
        println!("Dry run: configs carry a placeholder D1 id until the databases exist.");
    }
    crate::deploy_env::run(
        &env,
        &spec,
        &lock,
        &crate::deploy_guard::Options::from_args(args),
    )
    .await?;
    if !dry_run {
        let live = snapshot(&spec, &token).await?;
        let workers = inventory::deployables(&spec, &lock)?;
        plan::print(&env, &plan::diff(&spec, &lock, &workers, &live), &live);
    }
    Ok(())
}
