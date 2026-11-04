//! What each migration runner would record, for `cargo xtask health migrations`: it compares
//! these digests with a checked-in ledger, so a change that would fail `MIGRATION_DRIFT` on a
//! live store fails in CI first. Same arrays and same digest function as the runners.
use crate::repo_store::migration::APPLY_THROUGH;

/// One migration a store of this binary may have applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedMigration {
    pub store: &'static str,
    pub version: i64,
    pub digest: String,
}

/// Every migration this binary applies. An entry past `APPLY_THROUGH` is known but unapplied,
/// so its text may still change (`repo_store::migration`) and it's left out until wave 2.
pub fn applied_migrations() -> Vec<AppliedMigration> {
    let repo = crate::repo_store::migration::MIGRATIONS.iter();
    let repo = repo.filter(|(version, _)| *version <= APPLY_THROUGH);
    let stores = [
        ("repo_store", repo.copied().collect::<Vec<_>>()),
        ("commit_store", crate::commit_store::MIGRATIONS.to_vec()),
        ("accounts", crate::accounts::MIGRATIONS.to_vec()),
        ("read_copy", crate::read_copy::MIGRATIONS.to_vec()),
    ];
    let mut applied = Vec::new();
    for (store, migrations) in stores {
        for (version, sql) in migrations {
            applied.push(AppliedMigration {
                store,
                version,
                digest: yoneda_core::digest(sql.as_bytes()),
            });
        }
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_every_store_and_stops_at_the_apply_line() {
        let applied = applied_migrations();
        let last = |store: &str| {
            let versions = applied.iter().filter(|m| m.store == store);
            versions.map(|m| m.version).max()
        };
        assert_eq!(last("repo_store"), Some(APPLY_THROUGH));
        assert_eq!(last("commit_store"), Some(3));
        assert_eq!(last("accounts"), Some(16));
    }

    #[test]
    fn a_digest_is_the_one_the_runner_records() {
        let first = &applied_migrations()[0];
        let (version, sql) = crate::repo_store::migration::MIGRATIONS[0];
        assert_eq!(first.version, version);
        assert_eq!(first.digest, yoneda_core::digest(sql.as_bytes()));
    }
}
