use super::*;
use serde_json::json;

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|v| (*v).to_owned()).collect()
}
fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect()
}
fn worker(role: &str) -> Deployable {
    Deployable {
        name: format!("fixture-{role}"),
        role: role.into(),
        config_path: "not-used.jsonc".into(),
        config: json!({"name":format!("fixture-{role}"),"vars":{"API_REGION":"enam"},"services":[]}),
        secrets: vec!["OWNER_TOKEN".into()],
        optional_secrets: vec![
            "GITHUB_APP_PRIVATE_KEY".into(),
            "ANALYTICS_READ_TOKEN".into(),
        ],
        secret_files: BTreeMap::new(),
        health: None,
        has_containers: false,
        always_on: BTreeMap::new(),
    }
}
fn fixture() -> (Vec<Deployable>, Inventory) {
    let workers = vec![worker("platform"), worker("api-enam"), worker("api-weur")];
    let inventory = Inventory {
        missing: set(&["fixture-api-enam", "fixture-api-weur"]),
        secrets: BTreeMap::from([
            (
                "fixture-platform".into(),
                set(&["OWNER_TOKEN", "GITHUB_APP_PRIVATE_KEY"]),
            ),
            ("fixture-api-enam".into(), BTreeSet::new()),
            ("fixture-api-weur".into(), BTreeSet::new()),
        ]),
    };
    (workers, inventory)
}

#[test]
fn existing_primary_capability_cannot_disappear_at_an_alias() {
    let (workers, inventory) = fixture();
    for absent in [None, Some(""), Some("  ")] {
        let mut local = values(&[("OWNER_TOKEN", "fixture-owner")]);
        if let Some(v) = absent {
            local.insert("GITHUB_APP_PRIVATE_KEY".into(), v.into());
        }
        let error = validate(&workers, &inventory, &local)
            .unwrap_err()
            .to_string();
        assert!(error.contains("GITHUB_APP_PRIVATE_KEY"));
        assert!(!error.contains("fixture-owner"));
    }
}

#[test]
fn failed_preflight_never_returns_remote_activation_or_migration_steps() {
    let (workers, inventory) = fixture();
    let mut mutations = 0;
    let result = checked_plan(
        &Env::Dev,
        &workers,
        &Source::Dockerfile,
        false,
        &inventory,
        &values(&[("OWNER_TOKEN", "fixture-owner")]),
    )
    .map(|plan| {
        for step in plan {
            if step.mutates_remote() {
                mutations += 1;
            }
        }
    });
    assert!(result.is_err());
    assert_eq!(mutations, 0);
}

#[test]
fn declared_sources_can_restore_the_capability_without_changing_existing_values() {
    let (workers, inventory) = fixture();
    let local = values(&[
        ("OWNER_TOKEN", "fixture-owner"),
        ("GITHUB_APP_PRIVATE_KEY", "fixture-key"),
    ]);
    validate(&workers, &inventory, &local).unwrap();
    let plan = checked_plan(
        &Env::Dev,
        &workers,
        &Source::Dockerfile,
        false,
        &inventory,
        &local,
    )
    .unwrap();
    assert!(
        plan.iter()
            .any(|step| matches!(step, Step::Bootstrap { .. }))
    );
}

fn european() -> (Vec<Deployable>, Inventory) {
    let (mut workers, mut inventory) = fixture();
    workers[0].config["services"] =
        json!([{"binding":"CELL_WEUR","service":"fixture-platform-weur"}]);
    workers[0].secrets.extend([
        "LFS_S3_ACCESS_KEY_ID".into(),
        "LFS_S3_SECRET_ACCESS_KEY".into(),
    ]);
    inventory
        .secrets
        .get_mut("fixture-platform")
        .unwrap()
        .extend(set(&["LFS_S3_ACCESS_KEY_ID", "LFS_S3_SECRET_ACCESS_KEY"]));
    inventory.missing.clear();
    for api in workers.iter_mut().filter(|w| w.role.starts_with("api-")) {
        api.secrets.extend([
            "LFS_S3_ACCESS_KEY_ID".into(),
            "LFS_S3_SECRET_ACCESS_KEY".into(),
        ]);
        inventory
            .secrets
            .get_mut(&api.name)
            .unwrap()
            .extend(set(&["LFS_S3_ACCESS_KEY_ID", "LFS_S3_SECRET_ACCESS_KEY"]));
    }
    let mut eu = worker("platform-weur");
    eu.optional_secrets.extend([
        "LFS_S3_ACCESS_KEY_ID".into(),
        "LFS_S3_SECRET_ACCESS_KEY".into(),
    ]);
    eu.secret_files = BTreeMap::from([
        (
            "LFS_S3_ACCESS_KEY_ID".into(),
            "LFS_S3_ACCESS_KEY_ID_WEUR".into(),
        ),
        (
            "LFS_S3_SECRET_ACCESS_KEY".into(),
            "LFS_S3_SECRET_ACCESS_KEY_WEUR".into(),
        ),
    ]);
    inventory
        .secrets
        .insert(eu.name.clone(), set(&["OWNER_TOKEN"]));
    workers.push(eu);
    (workers, inventory)
}

#[test]
fn eu_lfs_requires_its_declared_pair_not_the_primary_bucket_credentials() {
    let (workers, inventory) = european();
    let mut local = values(&[
        ("OWNER_TOKEN", "fixture-owner"),
        ("GITHUB_APP_PRIVATE_KEY", "fixture-key"),
        ("LFS_S3_ACCESS_KEY_ID", "wrong-region-id"),
        ("LFS_S3_SECRET_ACCESS_KEY", "wrong-region-key"),
    ]);
    assert!(
        validate(&workers, &inventory, &local)
            .unwrap_err()
            .to_string()
            .contains("LFS_S3_ACCESS_KEY_ID_WEUR")
    );
    local.insert("LFS_S3_ACCESS_KEY_ID_WEUR".into(), "regional-id".into());
    assert!(
        validate(&workers, &inventory, &local)
            .unwrap_err()
            .to_string()
            .contains("LFS_S3_SECRET_ACCESS_KEY_WEUR")
    );
    local.insert(
        "LFS_S3_SECRET_ACCESS_KEY_WEUR".into(),
        "regional-key".into(),
    );
    validate(&workers, &inventory, &local).unwrap();
}

#[test]
fn unconfigured_optional_features_stay_optional_and_front_oauth_is_unrelated() {
    let (mut workers, mut inventory) = fixture();
    inventory
        .secrets
        .get_mut("fixture-platform")
        .unwrap()
        .remove("GITHUB_APP_PRIVATE_KEY");
    let mut front = worker("agents");
    front.secrets.push("FRONT_ONLY_SECRET".into());
    front
        .optional_secrets
        .push("GOOGLE_OAUTH_CLIENT_SECRET".into());
    workers.push(front);
    validate(
        &workers,
        &inventory,
        &values(&[("OWNER_TOKEN", "fixture-owner")]),
    )
    .unwrap();
}

#[test]
fn mapped_optional_sources_are_honored_instead_of_using_the_primary_source() {
    let (mut workers, inventory) = fixture();
    workers[1]
        .secret_files
        .insert("GITHUB_APP_PRIVATE_KEY".into(), "API_APP_KEY".into());
    let mut local = values(&[
        ("OWNER_TOKEN", "fixture-owner"),
        ("GITHUB_APP_PRIVATE_KEY", "fixture-key"),
    ]);
    assert!(
        validate(&workers, &inventory, &local)
            .unwrap_err()
            .to_string()
            .contains("API_APP_KEY")
    );
    local.insert("API_APP_KEY".into(), "fixture-mapped-key".into());
    validate(&workers, &inventory, &local).unwrap();
}

#[test]
fn existing_destination_secrets_do_not_require_local_plaintext_or_rotate_values() {
    let (workers, mut inventory) = fixture();
    inventory.missing.clear();
    for present in inventory.secrets.values_mut() {
        present.extend(set(&["OWNER_TOKEN", "GITHUB_APP_PRIVATE_KEY"]));
    }
    validate(&workers, &inventory, &BTreeMap::new()).unwrap();
    validate(&workers, &inventory, &values(&[("OWNER_TOKEN", " ")])).unwrap();
}

#[test]
fn missing_inventory_is_never_assumed_to_be_an_empty_destination() {
    let (workers, mut inventory) = fixture();
    inventory.secrets.remove("fixture-api-weur");
    assert!(
        validate(
            &workers,
            &inventory,
            &values(&[
                ("OWNER_TOKEN", "fixture-owner"),
                ("GITHUB_APP_PRIVATE_KEY", "fixture-key")
            ])
        )
        .unwrap_err()
        .to_string()
        .contains("inventory")
    );
}

#[test]
fn newly_configured_primary_features_are_also_preserved() {
    let (mut workers, mut inventory) = fixture();
    inventory
        .secrets
        .get_mut("fixture-platform")
        .unwrap()
        .remove("GITHUB_APP_PRIVATE_KEY");
    workers[1]
        .secret_files
        .insert("GITHUB_APP_PRIVATE_KEY".into(), "ALIAS_KEY".into());
    assert!(
        validate(
            &workers,
            &inventory,
            &values(&[
                ("OWNER_TOKEN", "fixture-owner"),
                ("GITHUB_APP_PRIVATE_KEY", "fixture-key")
            ])
        )
        .is_err()
    );
}

#[test]
fn alias_cannot_omit_the_declaration_for_an_existing_primary_capability() {
    let (mut workers, inventory) = fixture();
    workers[1].optional_secrets.clear();
    assert!(
        validate(
            &workers,
            &inventory,
            &values(&[
                ("OWNER_TOKEN", "fixture-owner"),
                ("GITHUB_APP_PRIVATE_KEY", "fixture-key")
            ])
        )
        .unwrap_err()
        .to_string()
        .contains("does not declare")
    );
}

#[test]
fn bound_eu_lfs_cannot_use_an_implicit_primary_mapping_but_existing_eu_keys_are_kept() {
    let (mut workers, mut inventory) = european();
    let eu = workers.last_mut().unwrap();
    eu.secret_files.clear();
    let local = values(&[
        ("OWNER_TOKEN", "fixture-owner"),
        ("GITHUB_APP_PRIVATE_KEY", "fixture-key"),
        ("LFS_S3_ACCESS_KEY_ID", "primary-id"),
        ("LFS_S3_SECRET_ACCESS_KEY", "primary-key"),
    ]);
    assert!(
        validate(&workers, &inventory, &local)
            .unwrap_err()
            .to_string()
            .contains("explicit regional source")
    );
    inventory
        .secrets
        .get_mut("fixture-platform-weur")
        .unwrap()
        .extend(set(&["LFS_S3_ACCESS_KEY_ID", "LFS_S3_SECRET_ACCESS_KEY"]));
    validate(&workers, &inventory, &local).unwrap();
}

#[test]
fn unbound_authority_is_not_part_of_the_activation_scope() {
    let (mut workers, mut inventory) = european();
    workers[0].config["services"] = json!([]);
    inventory.secrets.remove("fixture-platform-weur");
    let local = values(&[
        ("OWNER_TOKEN", "fixture-owner"),
        ("GITHUB_APP_PRIVATE_KEY", "fixture-key"),
        ("LFS_S3_ACCESS_KEY_ID", "primary-id"),
        ("LFS_S3_SECRET_ACCESS_KEY", "primary-key"),
    ]);
    validate(&workers, &inventory, &local).unwrap();
}

#[test]
fn offline_dry_run_does_not_need_sources_or_allow_remote_mutations() {
    let (workers, _) = fixture();
    let plan = checked_plan(
        &Env::Dev,
        &workers,
        &Source::Dockerfile,
        true,
        &Inventory::default(),
        &BTreeMap::new(),
    )
    .unwrap();
    assert!(plan.iter().all(|step| !step.mutates_remote()));
}

#[test]
fn generated_dev_and_prod_require_all_six_aliases_and_the_bound_eu_sources() {
    use crate::infra::{inventory::deployables, spec::Lock};
    for (source, lock) in [
        (
            include_str!("../../infra/envs/dev.json"),
            include_str!("../../infra/envs/dev.lock.json"),
        ),
        (
            include_str!("../../infra/envs/prod.json"),
            include_str!("../../infra/envs/prod.lock.json"),
        ),
    ] {
        let spec = crate::infra::spec::Spec::parse(source).unwrap();
        let lock: Lock = serde_json::from_str(lock).unwrap();
        let workers = deployables(&spec, &lock).unwrap();
        let scoped = scope(&workers);
        assert_eq!(scoped.len(), 8);
        let primary = scoped[0];
        let active: BTreeSet<_> = primary
            .secrets
            .iter()
            .chain(&primary.optional_secrets)
            .cloned()
            .collect();
        let mut inventory = Inventory::default();
        let mut local = BTreeMap::new();
        for worker in &scoped {
            inventory.secrets.insert(
                worker.name.clone(),
                if worker.role == "platform" {
                    active.clone()
                } else {
                    BTreeSet::new()
                },
            );
            for name in worker.secrets.iter().chain(&worker.optional_secrets) {
                local.insert(source_key(worker, name).into(), "synthetic-source".into());
            }
        }
        validate(&workers, &inventory, &local).unwrap();
        local.remove("GITHUB_APP_PRIVATE_KEY");
        assert!(validate(&workers, &inventory, &local).is_err());
        local.insert("GITHUB_APP_PRIVATE_KEY".into(), "synthetic-source".into());
        for empty in [None, Some(""), Some(" \t")] {
            local.remove("LFS_S3_SECRET_ACCESS_KEY_WEUR");
            if let Some(value) = empty {
                local.insert("LFS_S3_SECRET_ACCESS_KEY_WEUR".into(), value.into());
            }
            let error = validate(&workers, &inventory, &local)
                .unwrap_err()
                .to_string();
            assert!(error.contains("LFS_S3_SECRET_ACCESS_KEY_WEUR"));
        }
    }
}
