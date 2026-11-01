//! `cargo xtask rollback`: every Worker back one deployment, in reverse deploy order, then a row
//! in the deploy ledger for what is running now.
use crate::deploy_guard::{self as guard, Options};
use crate::deploy_ledger as ledger;
use crate::deploy_live::{active_instances, live_revision, status_table};
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler;
use crate::process::Result;

pub(crate) async fn rollback(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let options = Options::from_args(args)?;
    if env.is_prod() && !options.confirm {
        return Err("Refusing to roll back prod without --confirm.".into());
    }
    let spec = Spec::load(&env)?;
    let workers = inventory::deployables(&spec, &Lock::load(&env)?)?;
    let started_at = ledger::now_ms();
    let outcome = roll_back_each(&env, &spec, &workers, &options);
    if !options.dry_run {
        record(&env, &spec, &workers, outcome.is_ok(), started_at).await;
    }
    outcome?;
    status_table(&env, &workers).await
}

/// What the rollback left running goes in the ledger: its revision comes from `/health`, not
/// from HEAD. Superfan rolls back too, so this reaches the previous release's Superfan.
async fn record(env: &Env, spec: &Spec, workers: &[Deployable], ok: bool, started_at: u64) {
    let live = match workers.iter().find(|w| w.role == "platform") {
        Some(worker) => live_revision(worker).await,
        None => None,
    };
    let Some(revision) = live else {
        println!("WARNING: deploy ledger not written: the platform /health is unreadable.");
        return;
    };
    let entry = ledger::Entry::new(env, &revision, ledger::Kind::Rollback, ok, started_at);
    ledger::record(spec, workers, &entry).await;
}

fn roll_back_each(env: &Env, spec: &Spec, workers: &[Deployable], options: &Options) -> Result<()> {
    let message = format!("cargo xtask rollback --env {}", env.name());
    for worker in workers.iter().rev() {
        if env.is_prod() && worker.has_containers {
            let active = active_instances(&spec.account_id, worker)?;
            guard::active_gate(env, &worker.name, active, options)?;
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
    Ok(())
}
