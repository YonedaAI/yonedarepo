use super::inventory;
use super::jsonc;
use super::spec::{Env, Lock, Spec};
use serde_json::{Value, json};

const DEV: &str = include_str!("../../../infra/envs/dev.json");
const DEV_LOCK: &str = include_str!("../../../infra/envs/dev.lock.json");
const PROD: &str = include_str!("../../../infra/envs/prod.json");
const PROD_LOCK: &str = include_str!("../../../infra/envs/prod.lock.json");

fn committed(file: &str) -> Value {
    let text = match file {
        "wrangler.staging-platform.jsonc" => {
            include_str!("../../../cloudflare/wrangler.staging-platform.jsonc")
        }
        "wrangler.staging-agents.jsonc" => {
            include_str!("../../../cloudflare/wrangler.staging-agents.jsonc")
        }
        "wrangler.staging-superfan.jsonc" => {
            include_str!("../../../cloudflare/wrangler.staging-superfan.jsonc")
        }
        "wrangler.staging-sites.jsonc" => {
            include_str!("../../../cloudflare/wrangler.staging-sites.jsonc")
        }
        "wrangler.prod.jsonc" => include_str!("../../../cloudflare/wrangler.prod.jsonc"),
        "wrangler.sites.jsonc" => include_str!("../../../cloudflare/wrangler.sites.jsonc"),
        "wrangler.apps.jsonc" => include_str!("../../../cloudflare/wrangler.apps.jsonc"),
        other => panic!("no golden for {other}"),
    };
    jsonc::parse(text).unwrap()
}
fn lock(text: &str) -> Lock {
    serde_json::from_str(text).unwrap()
}
fn all_strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(s) => out.push(s.clone()),
        Value::Array(items) => items.iter().for_each(|v| all_strings(v, out)),
        Value::Object(map) => map.values().for_each(|v| all_strings(v, out)),
        _ => {}
    }
}

#[test]
fn dev_spec_regenerates_the_committed_staging_configs() {
    let spec = Spec::parse(DEV).unwrap();
    let files: Vec<&str> = spec.workers.iter().map(|w| w.file.as_str()).collect();
    assert_eq!(
        files,
        [
            "wrangler.staging-superfan.jsonc",
            "wrangler.staging-platform.jsonc",
            "wrangler.staging-agents.jsonc",
            "wrangler.staging-sites.jsonc"
        ],
        "the platform's tail consumer first, then cutover order: platform, agents, sites"
    );
    for (worker, config) in spec.configs(&lock(DEV_LOCK)).unwrap() {
        assert_eq!(
            config,
            committed(&worker.file),
            "{} drifted from infra/envs/dev.json",
            worker.file
        );
    }
}

#[test]
fn prod_spec_regenerates_todays_production_configs() {
    let spec = Spec::parse(PROD).unwrap();
    for (worker, config) in spec.configs(&lock(PROD_LOCK)).unwrap() {
        assert_eq!(
            config,
            committed(&worker.file),
            "{} drifted from infra/envs/prod.json",
            worker.file
        );
    }
    let names: Vec<String> = spec
        .workers
        .iter()
        .map(|w| w.config["name"].as_str().unwrap().into())
        .collect();
    assert_eq!(
        names,
        [
            "yonedarepo-dev",
            "yonedarepo-sites-dev",
            "yonedarepo-apps-dev"
        ]
    );
}

#[test]
fn generated_files_round_trip_through_the_renderer() {
    let spec = Spec::parse(DEV).unwrap();
    for (worker, config) in spec.configs(&lock(DEV_LOCK)).unwrap() {
        let text = jsonc::render(&worker.notes, &config, "infra/envs/dev.json").unwrap();
        assert!(text.starts_with("// Generated from infra/envs/dev.json"));
        assert_eq!(jsonc::parse(&text).unwrap(), config);
    }
}

#[test]
fn ephemeral_env_shares_nothing_with_dev() {
    let env = Env::parse("ephemeral-t1").unwrap();
    let spec = Spec::parse(DEV).unwrap().ephemeral(&env);
    assert_eq!(spec.prefix, "yonedarepo-eph-t1");
    assert_eq!(spec.git_ref, None);
    assert_eq!(spec.secrets_file, ".local/infra/ephemeral-t1/secrets.env");
    let mut ephemeral_lock = Lock::default();
    for name in [
        "yonedarepo-eph-t1-platform-index",
        "yonedarepo-eph-t1-agents-index",
    ] {
        ephemeral_lock
            .d1
            .insert(name.into(), "00000000-0000-4000-8000-000000000000".into());
    }
    for (worker, config) in spec.configs(&ephemeral_lock).unwrap() {
        assert_eq!(
            worker.file,
            format!("wrangler.ephemeral-t1-{}.jsonc", worker.role)
        );
        assert!(
            config.get("routes").is_none(),
            "no zone routes for {}",
            worker.role
        );
        assert_eq!(config["workers_dev"], json!(true));
        for container in config["containers"].as_array().into_iter().flatten() {
            assert_eq!(container["max_instances"], json!(1));
        }
        let mut strings = Vec::new();
        all_strings(&config, &mut strings);
        assert!(
            !strings
                .iter()
                .any(|s| s.contains("yonedarepo-staging") || s.contains("dev.yonedarepo.com")),
            "{} still names a dev resource",
            worker.role
        );
        assert!(
            config["name"]
                .as_str()
                .unwrap()
                .starts_with("yonedarepo-eph-t1-")
        );
    }
    let agents = spec
        .worker_config(&spec.workers[1], &ephemeral_lock)
        .unwrap();
    assert_eq!(
        agents["vars"]["PUBLIC_APP_ORIGIN"],
        "https://yonedarepo-eph-t1-agents.mlong-f01.workers.dev"
    );
    assert_eq!(agents["ratelimits"][0]["namespace_id"], "2900");
}

#[test]
fn missing_lock_entries_and_unknown_templates_fail_closed() {
    let spec = Spec::parse(DEV).unwrap();
    let platform = spec
        .workers
        .iter()
        .position(|w| w.role == "platform")
        .unwrap();
    let error = spec
        .worker_config(&spec.workers[platform], &Lock::default())
        .unwrap_err();
    assert!(error.to_string().contains("not in the lock"), "{error}");
    let mut bad = spec.clone();
    bad.workers[platform].config["vars"]["X"] = json!("{nope}");
    let error = bad
        .worker_config(&bad.workers[platform], &lock(DEV_LOCK))
        .unwrap_err();
    assert!(
        error.to_string().contains("Unknown template {nope}"),
        "{error}"
    );
}

#[test]
fn environments_parse_strictly() {
    assert_eq!(Env::parse("dev").unwrap(), Env::Dev);
    assert_eq!(Env::parse("prod").unwrap(), Env::Prod);
    assert_eq!(
        Env::parse("ephemeral-ab12").unwrap(),
        Env::Ephemeral("ab12".into())
    );
    for bad in [
        "",
        "staging",
        "ephemeral-",
        "ephemeral-UP",
        "ephemeral-a_b",
        "ephemeral-0123456789abc",
    ] {
        assert!(Env::parse(bad).is_err(), "{bad:?} accepted");
    }
    assert_eq!(
        Env::Prod.lock_path().to_str(),
        Some("infra/envs/prod.lock.json")
    );
    assert_eq!(
        Env::parse("ephemeral-x").unwrap().lock_path().to_str(),
        Some(".local/infra/ephemeral-x/lock.json")
    );
}

#[test]
fn comments_are_stripped_outside_strings_only() {
    let text = "// head\n{\"url\": \"https://a.b/c\", /* x */ \"q\": \"\\\"//\"} // tail\n";
    assert_eq!(
        jsonc::parse(text).unwrap(),
        json!({"url": "https://a.b/c", "q": "\"//"})
    );
}

#[test]
fn inventory_reads_resources_and_health_origins() {
    let spec = Spec::parse(DEV).unwrap();
    let workers = inventory::deployables(&spec, &lock(DEV_LOCK)).unwrap();
    let by_role = |role: &str| workers.iter().find(|w| w.role == role).unwrap();
    let platform = by_role("platform");
    assert_eq!(
        platform.config_path,
        "cloudflare/wrangler.staging-platform.jsonc"
    );
    assert_eq!(
        platform.health,
        Some((
            "https://yonedarepo-staging-platform.mlong-f01.workers.dev".into(),
            "yonedarepo-platform".into()
        ))
    );
    assert!(platform.has_containers);
    assert_eq!(
        by_role("agents").health.as_ref().unwrap().0,
        "https://dev.yonedarepo.com"
    );
    assert_eq!(by_role("sites").health, None);
    assert_eq!(
        inventory::d1(&platform.config),
        [(
            "yonedarepo-staging-platform-index".to_string(),
            Some("cloudflare/migrations".to_string())
        )]
    );
    assert!(
        inventory::containers(&platform.config)
            .contains_key("yonedarepo-staging-platform-checkcontainer")
    );
}

#[test]
fn secrets_files_parse_without_comments_or_quotes() {
    let parsed = super::secrets::parse("# c\nOWNER_TOKEN=abc\n\nVAULT_KEY=\"0f\"\nbad line\n");
    assert_eq!(parsed.get("OWNER_TOKEN").map(String::as_str), Some("abc"));
    assert_eq!(parsed.get("VAULT_KEY").map(String::as_str), Some("0f"));
    assert_eq!(parsed.len(), 2);
}

mod plan_diff {
    use super::super::apply::{Create, creations, down_allowed};
    use super::super::live::{Live, LiveWorker};
    use super::super::plan::{Action, diff};
    use super::*;
    use std::collections::BTreeSet;

    /// A live snapshot that matches the dev spec exactly.
    fn matching() -> (Spec, Lock, Vec<inventory::Deployable>, Live) {
        let spec = Spec::parse(DEV).unwrap();
        let lock = lock(DEV_LOCK);
        let workers = inventory::deployables(&spec, &lock).unwrap();
        let mut live = Live {
            d1: lock.d1.clone(),
            ..Live::default()
        };
        for w in &workers {
            live.r2.extend(inventory::r2(&w.config));
            for queue in inventory::queues(&w.config) {
                live.queues.entry(queue).or_default();
            }
            for queue in inventory::consumers(&w.config) {
                live.queues.entry(queue).or_default().insert(w.name.clone());
            }
            live.workflows.extend(inventory::workflows(&w.config));
            for (app, declared) in inventory::containers(&w.config) {
                live.containers
                    .insert(app, json!({"max_instances": declared["max_instances"]}));
            }
            for route in inventory::routes(&w.config) {
                let map = if route.custom_domain {
                    &mut live.domains
                } else {
                    &mut live.routes
                };
                map.insert(route.pattern, w.name.clone());
            }
            let bindings: Vec<Value> = super::super::drift::declared_bindings(&w.config)
                .into_keys()
                .map(|name| json!({"name": name, "type": "inherit"}))
                .collect();
            live.workers.insert(
                w.name.clone(),
                LiveWorker {
                    settings: json!({
                        "bindings": bindings,
                        "compatibility_date": w.config["compatibility_date"],
                        "compatibility_flags": w.config["compatibility_flags"],
                        "observability": w.config["observability"],
                        "placement": w.config["placement"],
                        "limits": w.config["limits"],
                        "tail_consumers": w.config["tail_consumers"],
                    }),
                    secrets: w.secrets.iter().cloned().collect::<BTreeSet<_>>(),
                    migration_tag: inventory::last_migration_tag(&w.config),
                    workers_dev: w.config["workers_dev"].as_bool(),
                },
            );
        }
        (spec, lock, workers, live)
    }
    fn action(rows: &[super::super::plan::Row], kind: &str, name: &str) -> Action {
        rows.iter()
            .find(|r| r.kind == kind && r.name == name)
            .unwrap_or_else(|| panic!("no {kind} {name}"))
            .action
    }

    #[test]
    fn a_matching_account_is_all_unchanged() {
        let (spec, lock, workers, live) = matching();
        let rows = diff(&spec, &lock, &workers, &live);
        let unsettled: Vec<_> = rows
            .iter()
            .filter(|r| r.action != Action::Unchanged)
            .collect();
        assert!(unsettled.is_empty(), "{unsettled:?}");
        assert!(rows.len() > 20, "every resource is listed ({})", rows.len());
        assert!(creations(&rows).is_empty());
    }

    #[test]
    fn missing_resources_are_created_and_only_data_resources_need_explicit_creation() {
        let (spec, lock, workers, mut live) = matching();
        live.d1.remove("yonedarepo-staging-agents-index");
        live.r2.remove("yonedarepo-staging-platform-objects");
        live.queues.remove("yonedarepo-staging-agents-dead-letter");
        live.workers.remove("yonedarepo-staging-sites");
        live.domains.clear();
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "d1", "yonedarepo-staging-agents-index"),
            Action::Create
        );
        assert_eq!(
            action(&rows, "worker", "yonedarepo-staging-sites"),
            Action::Create
        );
        assert_eq!(
            action(&rows, "domain", "dev.yonedarepo.com"),
            Action::Create
        );
        assert_eq!(
            creations(&rows),
            [
                Create::R2("yonedarepo-staging-platform-objects".into()),
                Create::D1("yonedarepo-staging-agents-index".into()),
                Create::Queue("yonedarepo-staging-agents-dead-letter".into()),
            ]
        );
    }

    #[test]
    fn changed_settings_bindings_and_identities_are_drift() {
        let (spec, lock, workers, mut live) = matching();
        live.d1.insert(
            "yonedarepo-staging-platform-index".into(),
            "other-id".into(),
        );
        let platform = live.workers.get_mut("yonedarepo-staging-platform").unwrap();
        platform.settings["compatibility_date"] = json!("2026-01-01");
        platform.settings["bindings"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name": "ROGUE_MODE", "type": "plain_text", "text": "batch"}));
        platform.migration_tag = Some("v3".into());
        let agents = live.workers.get_mut("yonedarepo-staging-agents").unwrap();
        for binding in agents.settings["bindings"].as_array_mut().unwrap() {
            if binding["name"] == "PUBLIC_APP_ORIGIN" {
                *binding = json!({"name": "PUBLIC_APP_ORIGIN", "type": "plain_text", "text": "https://elsewhere"});
            }
        }
        live.routes.insert(
            "https://dev.yonedarepo.com/*".into(),
            "yonedarepo-apps-dev".into(),
        );
        live.containers.insert(
            "yonedarepo-staging-agents-executioncontainer".into(),
            json!({"max_instances": 16}),
        );
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "d1", "yonedarepo-staging-platform-index"),
            Action::Drift
        );
        let platform = rows
            .iter()
            .find(|r| r.name == "yonedarepo-staging-platform" && r.kind == "worker")
            .unwrap();
        assert_eq!(platform.action, Action::Drift);
        for needle in [
            "compatibility_date",
            "binding ROGUE_MODE (plain_text) not declared",
            "DO migration tag: declared v4",
        ] {
            assert!(
                platform.detail.contains(needle),
                "{needle} not in {}",
                platform.detail
            );
        }
        let agents = rows
            .iter()
            .find(|r| r.name == "yonedarepo-staging-agents" && r.kind == "worker")
            .unwrap();
        assert!(
            agents.detail.contains("PUBLIC_APP_ORIGIN"),
            "{}",
            agents.detail
        );
        assert_eq!(
            action(&rows, "route", "https://dev.yonedarepo.com/*"),
            Action::Drift
        );
        assert_eq!(
            action(
                &rows,
                "container",
                "yonedarepo-staging-agents-executioncontainer"
            ),
            Action::Drift
        );
    }

    #[test]
    fn deploy_time_vars_and_secret_bindings_are_not_drift() {
        let (spec, lock, workers, mut live) = matching();
        let platform = live.workers.get_mut("yonedarepo-staging-platform").unwrap();
        let bindings = platform.settings["bindings"].as_array_mut().unwrap();
        bindings.push(json!({"name": "BUILD_REVISION", "type": "plain_text", "text": "abc"}));
        bindings.push(json!({"name": "OWNER_TOKEN", "type": "secret_text"}));
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "worker", "yonedarepo-staging-platform"),
            Action::Unchanged
        );
    }

    #[test]
    fn unreadable_sections_are_unverified_never_unchanged_or_create() {
        let (spec, lock, workers, mut live) = matching();
        live.containers.clear();
        live.errors.push("Containers: HTTP 403".into());
        live.workers.clear();
        live.errors.push("Workers: HTTP 403".into());
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(
                &rows,
                "container",
                "yonedarepo-staging-platform-checkcontainer"
            ),
            Action::Unknown
        );
        assert_eq!(
            action(&rows, "worker", "yonedarepo-staging-agents"),
            Action::Unknown
        );
        assert_eq!(
            action(&rows, "secret", "yonedarepo-staging-agents/VAULT_KEY"),
            Action::Unknown
        );
        assert!(creations(&rows).is_empty());
    }

    #[test]
    fn undeclared_resources_under_the_prefix_are_extra() {
        let (spec, lock, workers, mut live) = matching();
        live.workers
            .insert("yonedarepo-staging-bench".into(), LiveWorker::default());
        live.workers
            .insert("yonedarepo-platform-dev".into(), LiveWorker::default());
        live.r2.insert("yonedarepo-staging-leftover".into());
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "worker", "yonedarepo-staging-bench"),
            Action::Extra
        );
        assert_eq!(
            action(&rows, "r2", "yonedarepo-staging-leftover"),
            Action::Extra
        );
        assert!(
            !rows.iter().any(|r| r.name == "yonedarepo-platform-dev"),
            "other prefixes are ignored"
        );
    }

    #[test]
    fn prod_down_is_refused_in_code() {
        let error = down_allowed(&Env::Prod, true).unwrap_err().to_string();
        assert!(error.contains("never runs against prod"), "{error}");
        assert!(
            down_allowed(&Env::Dev, false).is_err(),
            "--confirm required"
        );
        down_allowed(&Env::Dev, true).unwrap();
        down_allowed(&Env::parse("ephemeral-x").unwrap(), true).unwrap();
    }
}

#[test]
fn check_capacity_is_one_number_for_containers_and_their_consumer() {
    let mut spec = Spec::parse(DEV).unwrap();
    assert_eq!(spec.check_instances, Some(4));
    spec.check_instances = Some(7);
    let platform = spec
        .workers
        .iter()
        .find(|w| w.role == "platform")
        .unwrap()
        .clone();
    let config = spec.worker_config(&platform, &lock(DEV_LOCK)).unwrap();
    let check = config["containers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["class_name"] == "CheckContainer")
        .unwrap();
    assert_eq!(check["max_instances"], json!(7));
    let consumer = config["queues"]["consumers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["queue"] == "yonedarepo-staging-platform-checks")
        .unwrap();
    assert_eq!(consumer["max_concurrency"], json!(7));
    let jobs = config["queues"]["consumers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["queue"] == "yonedarepo-staging-platform-jobs")
        .unwrap();
    assert_eq!(
        jobs["max_concurrency"],
        json!(20),
        "other consumers keep their own setting"
    );
    spec.check_instances = None;
    let error = spec
        .worker_config(&platform, &lock(DEV_LOCK))
        .unwrap_err()
        .to_string();
    assert!(error.contains("needs check_instances"), "{error}");
    let ephemeral = Spec::parse(DEV)
        .unwrap()
        .ephemeral(&Env::parse("ephemeral-c").unwrap());
    assert_eq!(ephemeral.check_instances, Some(1));
    assert!(
        Spec::parse(PROD).unwrap().check_instances.is_none(),
        "prod runs no CheckContainer today"
    );
}
