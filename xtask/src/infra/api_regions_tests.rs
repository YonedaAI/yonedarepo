use super::inventory::{self, Deployable};
use super::spec::{Lock, Spec};
use serde_json::{Value, json};

const REGIONS: [(&str, &str); 6] = [
    ("enam", "aws:us-east-1"),
    ("weur", "aws:eu-central-1"),
    ("apac", "aws:ap-southeast-1"),
    ("oc", "aws:ap-southeast-2"),
    ("sam", "aws:sa-east-1"),
    ("afr", "aws:af-south-1"),
];
fn source(prod: bool) -> Value {
    serde_json::from_str(if prod {
        include_str!("../../../infra/envs/prod.json")
    } else {
        include_str!("../../../infra/envs/dev.json")
    })
    .unwrap()
}
fn configured(prod: bool) -> Vec<Deployable> {
    let mut value = source(prod);
    value["api_regions"] =
        json!(REGIONS.map(|(code, placement)| json!({"code":code,"placement":placement})));
    let spec = Spec::parse(&value.to_string()).unwrap();
    let lock: Lock = serde_json::from_str(if prod {
        include_str!("../../../infra/envs/prod.lock.json")
    } else {
        include_str!("../../../infra/envs/dev.lock.json")
    })
    .unwrap();
    inventory::deployables(&spec, &lock).unwrap()
}
fn role<'a>(workers: &'a [Deployable], name: &str) -> &'a Deployable {
    workers.iter().find(|w| w.role == name).unwrap()
}
#[test]
fn regional_apis_are_placed_default_fetch_aliases_of_the_original_authorities() {
    for prod in [false, true] {
        let workers = configured(prod);
        let primary = role(&workers, "platform");
        assert_eq!(
            workers
                .iter()
                .filter(|w| w.role.starts_with("api-"))
                .count(),
            6
        );
        for (code, placement) in REGIONS {
            let api = role(&workers, &format!("api-{code}"));
            let config = &api.config;
            assert_eq!(
                api.name,
                format!(
                    "{}-api-{code}",
                    if prod {
                        "yonedarepo-prod"
                    } else {
                        "yonedarepo-dev"
                    }
                )
            );
            assert_eq!(config["main"], primary.config["main"]);
            assert_eq!(
                config["placement"],
                json!({"mode":"targeted","region":placement})
            );
            assert_eq!(config["vars"]["API_REGION"], code);
            assert_eq!(config["vars"]["CELL"], "enam");
            assert_eq!(config["vars"]["REGIONAL_API"], "on");
            assert_eq!(api.health.as_ref().unwrap().1, "yonedarepo-platform");
            assert!(!api.has_containers && api.always_on.is_empty());
            for field in ["migrations", "containers", "routes", "triggers", "assets"] {
                assert!(config.get(field).is_none(), "{code}:{field}");
            }
            assert!(config["queues"].get("consumers").is_none());
            for field in [
                "r2_buckets",
                "d1_databases",
                "ratelimits",
                "secrets_store_secrets",
            ] {
                assert_eq!(config[field], primary.config[field], "{code}:{field}");
            }
            assert_eq!(
                config["queues"]["producers"],
                primary.config["queues"]["producers"]
            );
            assert_eq!(api.secrets, primary.secrets);
            assert_eq!(api.optional_secrets, primary.optional_secrets);
            assert_eq!(api.secret_files, primary.secret_files);
            for binding in config["durable_objects"]["bindings"].as_array().unwrap() {
                assert_eq!(binding["script_name"], primary.name);
            }
            for binding in config["workflows"].as_array().unwrap() {
                assert_eq!(binding["script_name"], primary.name);
                assert_eq!(binding["name"], primary.config["workflows"][0]["name"]);
            }
            assert!(
                inventory::workflows(config).is_empty(),
                "external references own no workflow"
            );
        }
    }
}
#[test]
fn entry_workers_are_unplaced_and_bind_all_regions_without_named_entrypoints() {
    for prod in [false, true] {
        let workers = configured(prod);
        for name in ["platform", "agents", "edge"] {
            if prod && name == "edge" {
                continue;
            }
            let c = &role(&workers, name).config;
            assert!(c.get("placement").is_none());
            assert_eq!(c["vars"]["REGIONAL_API"], "on");
            assert!(c["vars"].get("API_REGION").is_none());
            for (code, _) in REGIONS {
                let binding = c["services"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["binding"] == format!("API_{}", code.to_uppercase()))
                    .unwrap();
                assert_eq!(
                    binding["service"],
                    role(&workers, &format!("api-{code}")).name
                );
                assert!(binding.get("entrypoint").is_none());
            }
        }
        let eu = &role(&workers, "platform-weur").config;
        assert_eq!(eu["vars"]["CELL"], "weur");
        assert_eq!(eu["vars"]["API_REGION"], "weur");
        assert_eq!(
            eu["placement"],
            json!({"mode":"targeted","region":"aws:eu-central-1"})
        );
    }
}
#[test]
fn unknown_or_duplicate_api_regions_fail_before_generation() {
    for regions in [
        json!([{"code":"unknown","placement":"aws:us-east-1"}]),
        json!([{"code":"enam","placement":"aws:us-east-1"},{"code":"enam","placement":"aws:us-east-1"}]),
        json!([{"code":"enam","placement":"smart"}]),
        json!([{"code":"weur","placement":"aws:eu-central-1"}]),
    ] {
        let mut value = source(false);
        value["api_regions"] = regions;
        assert!(Spec::parse(&value.to_string()).is_err());
    }
}

#[test]
fn first_rollout_stages_original_providers_then_aliases_before_bound_entries() {
    use crate::deploy_env::{Source, Step, steps};
    use crate::infra::spec::Env;
    use std::collections::BTreeSet;
    for (prod, env) in [(false, Env::Dev), (true, Env::Prod)] {
        let workers = configured(prod);
        let missing: BTreeSet<_> = workers
            .iter()
            .filter(|w| w.role.starts_with("api-") || w.role == "platform-weur")
            .map(|w| w.name.clone())
            .collect();
        let ordinary = steps(&env, &workers, false, &Source::Dockerfile);
        let plan = crate::deploy_bootstrap::insert(ordinary, &workers, &missing).unwrap();
        let primary = workers.iter().position(|w| w.role == "platform").unwrap();
        let bound = plan
            .iter()
            .position(|s| matches!(s,Step::Deploy{worker,..} if *worker==primary))
            .unwrap();
        let boots: Vec<_> = plan
            .iter()
            .enumerate()
            .filter_map(|(at, s)| {
                if let Step::Bootstrap { worker, config } = s {
                    Some((at, *worker, config))
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(boots.len(), 15);
        assert_eq!(workers[boots[0].1].role, "platform");
        assert_eq!(workers[boots[1].1].role, "platform-weur");
        for (stage, (at, index, c)) in boots.into_iter().enumerate() {
            assert!(at < bound);
            if stage < 8 {
                assert_eq!(c["vars"]["REGIONAL_API"], "off");
            } else {
                assert!(
                    c == &workers[index].config,
                    "nonentry handler must have its exact final bindings"
                );
                assert!(c["vars"].get("API_REGION").is_some());
            }
            assert_eq!(
                c["durable_objects"],
                workers[index].config["durable_objects"]
            );
            assert_eq!(c.get("migrations"), workers[index].config.get("migrations"));
            if stage < 8 {
                assert_eq!(
                    c["services"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|s| s["binding"].as_str().is_some_and(|b| b.starts_with("API_")))
                        .count(),
                    0
                );
            }
        }
        assert_eq!(workers[primary].config["vars"]["REGIONAL_API"], "on");
        assert!(plan.iter().all(
            |s| !matches!(s,Step::ActiveGate{worker} if workers[*worker].role.starts_with("api-"))
        ));
        let dry = steps(&env, &workers, true, &Source::Dockerfile);
        assert_eq!(
            crate::deploy_bootstrap::insert(dry.clone(), &workers, &missing).unwrap(),
            dry
        );
    }
}

#[test]
fn optional_regions_and_feature_off_leave_no_new_storage_or_secret_setup() {
    use super::retired::{self, Kind};
    for prod in [false, true] {
        let workers = configured(prod);
        let mut without = source(prod);
        without["api_regions"] = json!([]);
        let spec = Spec::parse(&without.to_string()).unwrap();
        let lock: Lock = serde_json::from_str(if prod {
            include_str!("../../../infra/envs/prod.lock.json")
        } else {
            include_str!("../../../infra/envs/dev.lock.json")
        })
        .unwrap();
        let original = inventory::deployables(&spec, &lock).unwrap();
        let resources = |w: &[Deployable]| {
            retired::declared(w)
                .into_iter()
                .filter(|(kind, _)| *kind != Kind::Worker)
                .collect::<std::collections::BTreeSet<_>>()
        };
        assert_eq!(resources(&workers), resources(&original));
        let mut value = source(prod);
        for worker in value["workers"].as_array_mut().unwrap() {
            if let Some(vars) = worker["config"]["vars"].as_object_mut() {
                vars.insert("REGIONAL_API".into(), json!("off"));
            }
        }
        let off = Spec::parse(&value.to_string()).unwrap();
        assert!(
            off.workers
                .iter()
                .filter(|w| w.role.starts_with("api-"))
                .all(|w| w.config["vars"]["REGIONAL_API"] == "off")
        );
        let ephemeral = Spec::parse(&source(prod).to_string())
            .unwrap()
            .ephemeral(&super::spec::Env::Ephemeral("regional".into()));
        assert!(ephemeral.api_regions.is_empty());
        assert!(!ephemeral.workers.iter().any(|w| w.role.starts_with("api-")));
        for w in ephemeral.workers {
            assert!(
                w.config["services"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .all(|s| !s["binding"].as_str().is_some_and(|b| b.starts_with("API_")))
            );
        }
    }
}

#[test]
fn committed_environment_specs_enable_identical_six_region_dispatch() {
    for prod in [false, true] {
        let spec = Spec::parse(&source(prod).to_string()).unwrap();
        assert_eq!(
            spec.api_regions
                .iter()
                .map(|r| (r.code.as_str(), r.placement.as_str()))
                .collect::<Vec<_>>(),
            REGIONS
        );
        for role in ["platform", "agents", "edge"] {
            if prod && role == "edge" {
                continue;
            }
            let w = spec.workers.iter().find(|w| w.role == role).unwrap();
            assert_eq!(w.config["vars"]["REGIONAL_API"], "on");
        }
    }
}

#[test]
fn authority_forwarding_never_reenters_the_global_dispatcher() {
    for prod in [false, true] {
        let workers = configured(prod);
        let target = role(&workers, "api-enam").name.clone();
        for worker in workers.iter().filter(|w| {
            matches!(
                w.role.as_str(),
                "platform" | "platform-weur" | "agents" | "edge"
            ) || w.role.starts_with("api-")
        }) {
            let enam = worker.config["services"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["binding"] == "CELL_ENAM")
                .unwrap();
            assert!(enam.get("entrypoint").is_none());
            assert_eq!(
                enam["service"], target,
                "{} must forward to the non-dispatching authority adapter",
                worker.role
            );
        }
    }
}
#[test]
fn missing_default_api_alias_uses_the_legacy_authority_during_unbound_bootstrap() {
    use std::collections::BTreeSet;
    let workers = configured(false);
    let primary = role(&workers, "platform").name.clone();
    let missing = BTreeSet::from([role(&workers, "api-enam").name.clone()]);
    for name in [
        "platform",
        "platform-weur",
        "api-enam",
        "api-weur",
        "api-afr",
    ] {
        let worker = role(&workers, name);
        let c = crate::deploy_bootstrap::configuration(&worker.config, &missing).unwrap();
        assert_eq!(c["vars"]["REGIONAL_API"], "off");
        let enam = c["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["binding"] == "CELL_ENAM")
            .unwrap();
        assert_eq!(enam["service"], primary);
        assert_eq!(c["durable_objects"], worker.config["durable_objects"]);
        assert_eq!(c["workflows"], worker.config["workflows"]);
    }
}

#[test]
fn api_only_bootstrap_preserves_creator_locality_but_missing_authorities_disable_it() {
    use std::collections::BTreeSet;
    for prod in [false, true] {
        let workers = configured(prod);
        let api_missing = BTreeSet::from([
            role(&workers, "api-enam").name.clone(),
            role(&workers, "api-apac").name.clone(),
        ]);
        let provider_missing = api_missing
            .iter()
            .cloned()
            .chain([role(&workers, "platform-weur").name.clone()])
            .collect();
        for name in ["platform", "platform-weur", "api-enam", "api-apac"] {
            let original = &role(&workers, name).config;
            assert_eq!(original["vars"]["AUTOMATIC_LOCALITY"], "on");
            let alias_stage =
                crate::deploy_bootstrap::configuration(original, &api_missing).unwrap();
            assert_eq!(
                alias_stage["vars"]["AUTOMATIC_LOCALITY"], "on",
                "{name}: existing authorities still place new repositories near their creator"
            );
            assert_eq!(alias_stage["vars"]["REGIONAL_API"], "off");
            let provider_stage =
                crate::deploy_bootstrap::configuration(original, &provider_missing).unwrap();
            assert_eq!(provider_stage["vars"]["AUTOMATIC_LOCALITY"], "off");
            assert_eq!(provider_stage["vars"]["REGIONAL_API"], "off");
            let mut explicit_off = original.clone();
            explicit_off["vars"]["AUTOMATIC_LOCALITY"] = json!("off");
            assert_eq!(
                crate::deploy_bootstrap::configuration(&explicit_off, &api_missing).unwrap()["vars"]
                    ["AUTOMATIC_LOCALITY"],
                "off"
            );
        }
    }
}

#[test]
fn every_nonentry_handler_is_fully_bound_before_global_entry_activation() {
    use crate::deploy_env::{Source, Step, steps};
    use crate::infra::spec::Env;
    use std::collections::{BTreeMap, BTreeSet};
    for (prod, env) in [(false, Env::Dev), (true, Env::Prod)] {
        for missing_eu in [false, true] {
            let workers = configured(prod);
            let primary = workers.iter().position(|w| w.role == "platform").unwrap();
            let missing: BTreeSet<_> = workers
                .iter()
                .filter(|w| w.role.starts_with("api-") || (missing_eu && w.role == "platform-weur"))
                .map(|w| w.name.clone())
                .collect();
            let plan = crate::deploy_bootstrap::insert(
                steps(&env, &workers, false, &Source::Dockerfile),
                &workers,
                &missing,
            )
            .unwrap();
            let mut staged = BTreeMap::new();
            for (at, step) in plan.iter().enumerate() {
                if let Step::Bootstrap { worker, config } = step {
                    staged.insert(*worker, config);
                    if config == &workers[*worker].config {
                        assert_eq!(plan[at - 1], Step::RolloutGate);
                        if prod && workers[*worker].has_containers {
                            assert_eq!(plan[at - 2], Step::ActiveGate { worker: *worker });
                        }
                        assert_eq!(plan[at + 1], Step::Secrets { worker: *worker });
                        assert_eq!(plan[at + 2], Step::Health { worker: *worker });
                    }
                }
                if matches!(step,Step::Deploy{worker,..} if *worker==primary) {
                    assert_eq!(workers[primary].config["vars"]["REGIONAL_API"], "on");
                    for (index, w) in workers
                        .iter()
                        .enumerate()
                        .filter(|(_, w)| w.role == "platform-weur" || w.role.starts_with("api-"))
                    {
                        assert!(
                            staged.get(&index).copied() == Some(&w.config),
                            "{} is still staged with incomplete authority bindings",
                            w.role
                        );
                    }
                    break;
                }
            }
        }
    }
}

#[test]
fn retry_restores_existing_but_unbound_receivers_before_entry_activation() {
    use crate::deploy_env::{Source, Step, steps};
    use crate::infra::spec::Env;
    use std::collections::{BTreeMap, BTreeSet};
    for (prod, env) in [(false, Env::Dev), (true, Env::Prod)] {
        let workers = configured(prod);
        let primary = workers.iter().position(|w| w.role == "platform").unwrap();
        let formerly_missing: BTreeSet<_> = workers
            .iter()
            .filter(|w| w.role.starts_with("api-"))
            .map(|w| w.name.clone())
            .collect();
        let mut active: BTreeMap<_, _> = workers
            .iter()
            .enumerate()
            .filter(|(_, w)| w.role == "platform-weur" || w.role.starts_with("api-"))
            .map(|(i, w)| {
                (
                    i,
                    crate::deploy_bootstrap::configuration(&w.config, &formerly_missing).unwrap(),
                )
            })
            .collect();
        // Every script exists after the interrupted first stage. Presence alone cannot
        // tell the ordinary primary-first retry that those receivers remain unbound.
        let plan = crate::deploy_bootstrap::insert(
            steps(&env, &workers, false, &Source::Dockerfile),
            &workers,
            &BTreeSet::new(),
        )
        .unwrap();
        let first = plan
            .iter()
            .find_map(|s| {
                if let Step::Bootstrap { worker, config } = s {
                    Some((*worker, config))
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(
            first.0, primary,
            "provider new source must precede all receivers"
        );
        assert_eq!(first.1["vars"]["REGIONAL_API"], "off");
        assert_eq!(first.1["vars"]["AUTOMATIC_LOCALITY"], "on");
        for step in &plan {
            if let Step::Bootstrap { worker, config } = step {
                active.insert(*worker, config.clone());
            }
            if matches!(step,Step::Deploy{worker,..} if *worker==primary) {
                for (index, w) in workers
                    .iter()
                    .enumerate()
                    .filter(|(_, w)| w.role == "platform-weur" || w.role.starts_with("api-"))
                {
                    assert!(
                        active.get(&index) == Some(&w.config),
                        "retry activated entry before restoring {}",
                        w.role
                    );
                }
                break;
            }
        }
    }
}
