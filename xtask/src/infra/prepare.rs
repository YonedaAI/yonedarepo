//! Explicit resource preparation; never deploys Workers, moves hosts or migrates data.

use super::apply;
use super::live::{self, Live};
use super::spec::{Env, Lock, PENDING_D1, Spec};
use super::{generate, inventory, plan};
use crate::process::Result;

fn dry_run(args: &[String]) -> Result<bool> {
    if args.iter().any(|a| a == "--dry-run") {
        return Ok(true);
    }
    if args.iter().any(|a| a == "--confirm") {
        return Ok(false);
    }
    Err("Resource preparation needs --dry-run or --confirm; it never deploys Workers".into())
}

fn readable(live: &Live) -> Result<()> {
    if !live.errors.is_empty() {
        return Err(format!(
            "Cannot verify resources; nothing was changed: {}",
            live.errors.join("; ")
        )
        .into());
    }
    Ok(())
}

/// A previously recorded identity cannot silently change, even to another valid database.
fn verify_recorded(spec: &Spec, recorded: &Lock, live: &Live) -> Result<()> {
    readable(live)?;
    for name in spec.d1_names()? {
        if let Some(id) = recorded
            .d1
            .get(&name)
            .filter(|id| !id.is_empty() && id.as_str() != PENDING_D1)
            && live.d1.get(&name) != Some(id)
        {
            return Err(format!("D1 identity is missing or changed for {name}; no resource or recorded identity was replaced").into());
        }
    }
    Ok(())
}

fn prepared_lock(spec: &Spec, recorded: &Lock, live: &Live) -> Result<Lock> {
    verify_recorded(spec, recorded, live)?;
    let mut lock = Lock::default();
    for name in spec.d1_names()? {
        let id = live
            .d1
            .get(&name)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| format!("D1 {name} is still missing; no lock was written"))?;
        lock.d1.insert(name, id.clone());
    }
    Ok(lock)
}

pub(crate) async fn run(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let dry = dry_run(args)?;
    let spec = Spec::load(&env)?;
    // Provisioning deliberately precedes the identity commit, but never starts from dirty
    // source. Deploy still enforces its own branch-tip, ship/evidence and active-run gates.
    let facts = crate::deploy_guard::git_facts(&spec)?;
    if !facts.dirty.is_empty() {
        return Err("Resource preparation needs a clean committed working tree".into());
    }
    let token = if args.iter().any(|a| a == "--token-file") {
        live::token(args)?
    } else {
        crate::deploy_credentials::load(&env.name(), &spec.account_id)?;
        crate::deploy_credentials::current()
            .ok_or("Resource preparation needs a Cloudflare API token")?
    };
    let recorded = Lock::load(&env)?;
    let live = apply::snapshot(&spec, &token).await?;
    verify_recorded(&spec, &recorded, &live)?;
    let effective = plan::effective_lock(&spec, &recorded, &live)?;
    let workers = inventory::deployables(&spec, &effective)?;
    let todo = apply::creations(&plan::diff(&spec, &recorded, &workers, &live));
    for item in &todo {
        apply::create(&spec, item, dry, Some(&token))?;
    }
    if dry {
        let observed = live
            .d1
            .iter()
            .filter(|(name, id)| {
                recorded.d1.get(*name) != Some(*id) && effective.d1.contains_key(*name)
            })
            .count();
        println!(
            "Dry run: would record {observed} observed D1 identities after preparation; unresolved identities remain unrecorded."
        );
        println!(
            "Dry run: no resources, identities, configs, Workers or hosts were changed. Run with --confirm to prepare, then review and commit the real identities before deploy."
        );
        return Ok(());
    }
    let actual = if todo.is_empty() {
        live
    } else {
        apply::snapshot(&spec, &token).await?
    };
    let lock = prepared_lock(&spec, &recorded, &actual)?;
    let workers = inventory::deployables(&spec, &lock)?;
    let remaining = apply::creations(&plan::diff(&spec, &lock, &workers, &actual));
    if !remaining.is_empty() {
        return Err("Resources remain unverified after creation; rerun preparation. No identity lock was written".into());
    }
    if lock != recorded {
        lock.save(&env)?;
    }
    let changed = generate::generate(&env, &spec, &lock, false)?
        .into_iter()
        .filter(|(_, changed)| *changed)
        .count();
    println!(
        "Resources prepared; {changed} configs regenerated. Review {} and generated configs, commit any changes, then use the normal guarded deploy. No Worker was deployed and no host moved.",
        env.lock_path().display()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::spec::PENDING_D1;
    #[test]
    fn preparation_requires_explicit_mode_and_dry_run_never_mutates() {
        assert!(dry_run(&[]).is_err());
        assert!(dry_run(&["--dry-run".into()]).unwrap());
        assert!(!dry_run(&["--confirm".into()]).unwrap());
        assert!(dry_run(&["--confirm".into(), "--dry-run".into()]).unwrap());
    }
    #[test]
    fn lock_accepts_only_observed_ids_and_refuses_changed_identity_or_failed_snapshot() {
        let spec = Spec::parse(include_str!("../../../infra/envs/dev.json")).unwrap();
        let names = spec.d1_names().unwrap();
        let recorded = Lock {
            d1: names
                .iter()
                .map(|name| (name.clone(), PENDING_D1.into()))
                .collect(),
        };
        let mut live = Live::default();
        assert!(prepared_lock(&spec, &recorded, &live).is_err());
        let actual: Lock =
            serde_json::from_str(include_str!("../../../infra/envs/dev.lock.json")).unwrap();
        live.d1 = actual.d1.clone();
        assert_eq!(prepared_lock(&spec, &recorded, &live).unwrap(), actual);
        let mut drift = actual.clone();
        drift
            .d1
            .insert(names[0].clone(), "a different recorded identity".into());
        assert!(prepared_lock(&spec, &drift, &live).is_err());
        live.errors.push("D1 read failed".into());
        assert!(prepared_lock(&spec, &recorded, &live).is_err());
    }
}
