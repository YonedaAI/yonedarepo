//! `cargo xtask rollback`: every Worker back one deployment, in reverse deploy order, then a row
//! in the deploy ledger for what is running now.
use crate::deploy_guard::{self as guard, Options};
use crate::deploy_ledger as ledger;
use crate::deploy_live::{active_instances, live_revision, status_table};
use crate::infra::inventory::{self, Deployable};
use crate::infra::spec::{Env, Lock, Spec};
use crate::infra::wrangler;
use crate::process::Result;
use serde_json::Value;

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
    let earlier = |worker: &Deployable| earlier_deployment(&spec.account_id, &worker.name);
    in_reverse(workers, earlier, |worker| {
        if env.is_prod() && worker.has_containers {
            let active = active_instances(&spec.account_id, worker)?;
            guard::active_gate(env, &worker.name, active, options)?;
        }
        if options.dry_run {
            println!(
                "Dry run: would roll back {} to its previous deployment.",
                worker.name
            );
            return Ok(());
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
        )
    })
}

/// Rolls back each worker, last deployed first. One with no earlier deployment has nothing to go
/// back to, which is no reason to leave the others on the release being undone. Any other failure
/// stops here, for the operator to see.
fn in_reverse<W>(
    workers: &[W],
    mut earlier: impl FnMut(&W) -> Result<Earlier>,
    mut roll: impl FnMut(&W) -> Result<()>,
) -> Result<()> {
    for worker in workers.iter().rev() {
        match earlier(worker)? {
            Earlier::Yes => roll(worker)?,
            Earlier::No(line) => println!("{line}"),
        }
    }
    Ok(())
}

/// Whether a Worker can go back; `No` holds the line that says why it doesn't.
#[derive(Debug, PartialEq, Eq)]
enum Earlier {
    Yes,
    No(String),
}

fn earlier_deployment(account_id: &str, name: &str) -> Result<Earlier> {
    let args = ["deployments", "list", "--name", name, "--json"];
    let skipped = |why: &str| Earlier::No(format!("Skipping {name}: {why}."));
    Ok(match wrangler::output_unless_missing(account_id, &args)? {
        None => skipped("it was never deployed here"),
        Some(listing) if has_earlier(&listing)? => Earlier::Yes,
        Some(_) => skipped("it has no earlier version, so it stays on this one"),
    })
}

/// What `wrangler rollback` picks with no version named: a deployment before the newest with one
/// version at 100%.
fn has_earlier(listing: &[u8]) -> Result<bool> {
    let mut deployments: Vec<Value> = serde_json::from_slice(listing)
        .map_err(|error| format!("Unreadable wrangler deployments list: {error}"))?;
    deployments.sort_by_key(|deployment| deployment["created_on"].as_str().map(str::to_owned));
    deployments.pop();
    Ok(deployments.iter().any(|deployment| {
        let mut versions = deployment["versions"].as_array().into_iter().flatten();
        versions.any(|version| version["percentage"].as_f64() == Some(100.0))
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    #[test]
    fn a_worker_with_no_earlier_version_is_skipped_and_the_rest_still_roll_back() {
        let rolled = RefCell::new(Vec::new());
        in_reverse(
            &["superfan", "platform", "deadman"],
            |w| {
                Ok(if *w == "deadman" {
                    Earlier::No("Skipping deadman".into())
                } else {
                    Earlier::Yes
                })
            },
            |w| {
                rolled.borrow_mut().push(*w);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(*rolled.borrow(), ["platform", "superfan"]);
    }

    #[test]
    fn a_rollback_that_fails_stops_there() {
        let rolled = RefCell::new(Vec::new());
        let out = in_reverse(
            &["superfan", "platform", "deadman"],
            |_| Ok(Earlier::Yes),
            |w| {
                rolled.borrow_mut().push(*w);
                if *w == "platform" {
                    Err("wrangler rollback failed".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(out.is_err());
        assert_eq!(*rolled.borrow(), ["deadman", "platform"]);
    }

    #[test]
    fn a_listing_that_cannot_be_read_stops_the_rollback() {
        let out = in_reverse(&["a"], |_| Err("list failed".into()), |_| Ok(()));
        assert!(out.is_err());
        assert!(has_earlier(b"not json").is_err());
    }

    fn deployment(created_on: &str, percentages: &[f64]) -> Value {
        let versions: Vec<Value> = percentages
            .iter()
            .map(|percentage| json!({"version_id": "v", "percentage": percentage}))
            .collect();
        json!({"created_on": created_on, "versions": versions})
    }

    fn earlier(deployments: Vec<Value>) -> bool {
        has_earlier(json!(deployments).to_string().as_bytes()).unwrap()
    }

    #[test]
    fn only_a_whole_deployment_before_the_newest_counts_as_earlier() {
        let (old, new) = ("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z");
        assert!(!earlier(vec![]));
        assert!(!earlier(vec![deployment(new, &[100.0])]));
        assert!(earlier(vec![
            deployment(old, &[100.0]),
            deployment(new, &[100.0])
        ]));
        // The order wrangler lists them in doesn't matter.
        assert!(earlier(vec![
            deployment(new, &[100.0]),
            deployment(old, &[100.0])
        ]));
        // A split deployment is no version to go back to, as for `wrangler rollback`.
        assert!(!earlier(vec![
            deployment(old, &[50.0, 50.0]),
            deployment(new, &[100.0])
        ]));
    }
}
