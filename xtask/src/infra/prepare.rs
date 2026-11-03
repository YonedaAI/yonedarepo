//! Explicit resource preparation; never deploys Workers, moves hosts or migrates data.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::spec::PENDING_D1;
    #[test]
    fn preparation_requires_explicit_mode_and_dry_run_never_mutates() {
        assert!(dry_run(&[]).is_err());
        assert!(dry_run(&["--dry-run".into()]).unwrap());
        assert!(!dry_run(&["--confirm".into()]).unwrap());
        assert!(dry_run(&["--confirm".into(),"--dry-run".into()]).unwrap());
    }
    #[test]
    fn lock_accepts_only_observed_ids_and_refuses_changed_identity_or_failed_snapshot() {
        let spec=Spec::parse(include_str!("../../../infra/envs/dev.json")).unwrap();
        let names=spec.d1_names().unwrap();
        let recorded=Lock{d1:names.iter().map(|name|(name.clone(),PENDING_D1.into())).collect()};
        let mut live=Live::default();
        assert!(prepared_lock(&spec,&recorded,&live).is_err());
        let actual:Lock=serde_json::from_str(include_str!("../../../infra/envs/dev.lock.json")).unwrap();
        live.d1=actual.d1.clone();
        assert_eq!(prepared_lock(&spec,&recorded,&live).unwrap(),actual);
        let mut drift=actual.clone();
        drift.d1.insert(names[0].clone(),"a different recorded identity".into());
        assert!(prepared_lock(&spec,&drift,&live).is_err());
        live.errors.push("D1 read failed".into());
        assert!(prepared_lock(&spec,&recorded,&live).is_err());
    }
}
