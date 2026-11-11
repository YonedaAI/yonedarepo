use super::inventory;
use super::jsonc;
use super::spec::{Env, Lock, Spec};
use serde_json::{Value, json};

const DEV: &str = include_str!("../../../infra/envs/dev.json");
const DEV_LOCK: &str = include_str!("../../../infra/envs/dev.lock.json");
const PROD: &str = include_str!("../../../infra/envs/prod.json");
const PROD_LOCK: &str = include_str!("../../../infra/envs/prod.lock.json");

#[test]
fn independent_watchers_reach_each_other_over_the_public_network() {
    // These probes deliberately use public URLs rather than service bindings: each watcher
    // must observe the other as an outside client would, including its public route.
    for text in [DEV, PROD] {
        let spec = Spec::parse(text).unwrap();
        for worker in spec
            .workers
            .iter()
            .filter(|w| matches!(w.role.as_str(), "superfan" | "deadman"))
        {
            assert!(
                worker.config["compatibility_flags"]
                    .as_array()
                    .is_some_and(|flags| flags.iter().any(|f| f == "global_fetch_strictly_public")),
                "{} must be able to fetch the other watcher's public Worker URL",
                worker.file
            );
        }
    }
}

fn committed(file: &str) -> Value {
    let text = match file {
        "wrangler.dev-platform.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-platform.jsonc")
        }
        "wrangler.dev-agents.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-agents.jsonc")
        }
        "wrangler.dev-agents-managed.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-agents-managed.jsonc")
        }
        "wrangler.dev-superfan.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-superfan.jsonc")
        }
        "wrangler.dev-bench.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-bench.jsonc")
        }
        "wrangler.dev-deadman.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-deadman.jsonc")
        }
        "wrangler.dev-bench2.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-bench2.jsonc")
        }
        "wrangler.dev-region-na.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-region-na.jsonc")
        }
        "wrangler.dev-region-eu.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-region-eu.jsonc")
        }
        "wrangler.dev-region-ap.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-region-ap.jsonc")
        }
        "wrangler.prod-superfan.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-superfan.jsonc")
        }
        "wrangler.prod-platform.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-platform.jsonc")
        }
        "wrangler.prod-platform-weur.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-platform-weur.jsonc")
        }
        "wrangler.prod-agents.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-agents.jsonc")
        }
        "wrangler.prod-agents-managed.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-agents-managed.jsonc")
        }
        "wrangler.dev-platform-weur.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-platform-weur.jsonc")
        }
        "wrangler.dev-edge.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-edge.jsonc")
        }
        "wrangler.dev-region-sa.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-region-sa.jsonc")
        }
        "wrangler.prod-deadman.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-deadman.jsonc")
        }
        "wrangler.dev-api-enam.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-api-enam.jsonc")
        }
        "wrangler.dev-api-weur.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-api-weur.jsonc")
        }
        "wrangler.dev-api-apac.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-api-apac.jsonc")
        }
        "wrangler.dev-api-oc.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-api-oc.jsonc")
        }
        "wrangler.dev-api-sam.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-api-sam.jsonc")
        }
        "wrangler.dev-api-afr.jsonc" => {
            include_str!("../../../cloudflare/wrangler.dev-api-afr.jsonc")
        }
        "wrangler.prod-api-enam.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-api-enam.jsonc")
        }
        "wrangler.prod-api-weur.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-api-weur.jsonc")
        }
        "wrangler.prod-api-apac.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-api-apac.jsonc")
        }
        "wrangler.prod-api-oc.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-api-oc.jsonc")
        }
        "wrangler.prod-api-sam.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-api-sam.jsonc")
        }
        "wrangler.prod-api-afr.jsonc" => {
            include_str!("../../../cloudflare/wrangler.prod-api-afr.jsonc")
        }
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
fn dev_spec_regenerates_the_committed_dev_configs() {
    let spec = Spec::parse(DEV).unwrap();
    let files: Vec<&str> = spec.workers.iter().map(|w| w.file.as_str()).collect();
    assert_eq!(
        files,
        [
            "wrangler.dev-superfan.jsonc",
            "wrangler.dev-platform.jsonc",
            "wrangler.dev-platform-weur.jsonc",
            "wrangler.dev-api-enam.jsonc",
            "wrangler.dev-api-weur.jsonc",
            "wrangler.dev-api-apac.jsonc",
            "wrangler.dev-api-oc.jsonc",
            "wrangler.dev-api-sam.jsonc",
            "wrangler.dev-api-afr.jsonc",
            "wrangler.dev-edge.jsonc",
            "wrangler.dev-agents-managed.jsonc",
            "wrangler.dev-agents.jsonc",
            "wrangler.dev-bench.jsonc",
            "wrangler.dev-bench2.jsonc",
            "wrangler.dev-region-na.jsonc",
            "wrangler.dev-region-eu.jsonc",
            "wrangler.dev-region-ap.jsonc",
            "wrangler.dev-region-sa.jsonc",
            "wrangler.dev-deadman.jsonc"
        ],
        "the platform's tail consumer first, then cutover order: platform, the managed agents the front binds, agents; the bench clients, the regional ones after the platform they bind, then the dead-man, last"
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
fn prod_spec_regenerates_the_committed_prod_configs() {
    let spec = Spec::parse(PROD).unwrap();
    for (worker, config) in spec.configs(&lock(PROD_LOCK)).unwrap() {
        assert_eq!(
            config,
            committed(&worker.file),
            "{} drifted from infra/envs/prod.json",
            worker.file
        );
    }
    assert_eq!(
        spec.worker_names().unwrap(),
        [
            "yonedarepo-prod-superfan",
            "yonedarepo-prod-platform",
            "yonedarepo-prod-platform-weur",
            "yonedarepo-prod-api-enam",
            "yonedarepo-prod-api-weur",
            "yonedarepo-prod-api-apac",
            "yonedarepo-prod-api-oc",
            "yonedarepo-prod-api-sam",
            "yonedarepo-prod-api-afr",
            "yonedarepo-prod-agents-managed",
            "yonedarepo-prod-agents",
            "yonedarepo-prod-deadman"
        ],
        "the platform's tail consumer first, then platform, managed agents, agents, the dead-man last; no bench in prod"
    );
    let files: Vec<&str> = spec.workers.iter().map(|w| w.file.as_str()).collect();
    assert!(
        files.iter().all(|f| f.starts_with("wrangler.prod-")),
        "{files:?}"
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
    assert!(spec.retired.is_empty(), "an ephemeral stack never prunes");
    assert_eq!(spec.git_ref, None);
    assert_eq!(spec.secrets_file, ".local/infra/ephemeral-t1/secrets.env");
    assert!(
        !spec.workers.iter().any(|w| w.role == "agents-managed"),
        "the managed agents Worker (one custom hostname per env) is not copied"
    );
    let front = spec.workers.iter().find(|w| w.role == "agents").unwrap();
    assert_eq!(
        front.config["services"],
        json!([{"binding": "PLATFORM", "service": "{prefix}-platform"}]),
        "no binding to a Worker the copy leaves out"
    );
    let mut ephemeral_lock = Lock::default();
    ephemeral_lock.d1.insert(
        "yonedarepo-eph-t1-platform-index".into(),
        "00000000-0000-4000-8000-000000000000".into(),
    );
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
        assert!(!worker.secrets.iter().any(|s| s.starts_with("LFS_S3_")));
        assert!(!worker.secrets.iter().any(|s| s.starts_with("SSH_")));
        if let Some(door) = config["vars"].get("SSH_FRONT_DOOR") {
            assert_eq!(door, "off", "Git over SSH is off in {}", worker.role);
        }
        for container in config["containers"].as_array().into_iter().flatten() {
            assert_eq!(container["max_instances"], json!(1));
        }
        let mut strings = Vec::new();
        all_strings(&config, &mut strings);
        // The App's name is GitHub's, not a resource here: without its key, Connect is off.
        strings.retain(|s| s != "yonedarepo-dev-import");
        assert!(
            !strings
                .iter()
                .any(|s| s.contains("yonedarepo-dev") || s.contains("dev.yonedarepo.com")),
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
        "cloudflare/wrangler.dev-platform.jsonc"
    );
    assert_eq!(
        platform.health,
        Some((
            // The platform's own custom domain wins over its workers.dev hostname.
            "https://api.dev.yonedarepo.com".into(),
            "yonedarepo-platform".into()
        ))
    );
    assert!(platform.has_containers);
    assert_eq!(
        by_role("agents").health.as_ref().unwrap().0,
        "https://dev.yonedarepo.com"
    );
    assert_eq!(
        inventory::d1(&platform.config),
        [
            (
                "yonedarepo-dev-platform-index".to_string(),
                Some("cloudflare/migrations".to_string())
            ),
            ("yonedarepo-dev-platform-index-weur".to_string(), None)
        ]
    );
    assert!(
        inventory::containers(&platform.config)
            .contains_key("yonedarepo-dev-platform-checkcontainer")
    );
}

/// Each database's migrations come from its own binding, so the managed Worker's D1 never takes
/// the platform's migrations, nor the platform's its. An entry that names no directory has no
/// migrations to apply.
#[test]
fn each_d1_database_keeps_its_own_migrations_directory() {
    let config = serde_json::json!({ "d1_databases": [
        { "database_name": "own", "migrations_dir": "managed/migrations" },
        { "database_name": "platform", "migrations_dir": "migrations" },
        { "database_name": "none" },
    ]});
    assert_eq!(
        inventory::d1(&config),
        [
            (
                "own".to_string(),
                Some("cloudflare/managed/migrations".to_string())
            ),
            (
                "platform".to_string(),
                Some("cloudflare/migrations".to_string())
            ),
            ("none".to_string(), None),
        ]
    );
}

#[test]
fn the_managed_worker_has_its_own_d1_and_not_the_platforms() {
    for (spec, lock, env) in [(DEV, DEV_LOCK, "dev"), (PROD, PROD_LOCK, "prod")] {
        let spec = Spec::parse(spec).unwrap();
        let workers = inventory::deployables(&spec, &self::lock(lock)).unwrap();
        let databases = |role: &str| {
            let worker = workers.iter().find(|w| w.role == role).unwrap();
            inventory::d1(&worker.config)
        };
        assert_eq!(
            databases("agents-managed"),
            [(
                format!("yonedarepo-{env}-managed-revenue"),
                Some("cloudflare/managed/migrations".to_string())
            )]
        );
        assert_eq!(
            databases("platform"),
            [
                (
                    format!("yonedarepo-{env}-platform-index"),
                    Some("cloudflare/migrations".to_string())
                ),
                (format!("yonedarepo-{env}-platform-index-weur"), None)
            ]
        );
        assert_eq!(
            databases("platform-weur"),
            [
                (
                    format!("yonedarepo-{env}-platform-index-weur"),
                    Some("cloudflare/migrations".to_string())
                ),
                (format!("yonedarepo-{env}-platform-index"), None)
            ],
            "only a database's owning Worker applies its migrations"
        );
    }
}

#[test]
fn secrets_files_parse_without_comments_or_quotes() {
    let parsed = super::secrets::parse("# c\nOWNER_TOKEN=abc\n\nVAULT_KEY=\"0f\"\nbad line\n");
    assert_eq!(parsed.get("OWNER_TOKEN").map(String::as_str), Some("abc"));
    assert_eq!(parsed.get("VAULT_KEY").map(String::as_str), Some("0f"));
    assert_eq!(parsed.len(), 2);
}

mod plan_diff {
    use super::super::apply::{Create, creations};
    use super::super::live::{Live, LiveWorker};
    use super::super::plan::{Action, diff};
    use super::super::teardown::down_allowed;
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
        live.d1.remove("yonedarepo-dev-platform-index");
        live.r2.remove("yonedarepo-dev-platform-objects");
        live.queues.remove("yonedarepo-dev-platform-dead-letter");
        live.workers.remove("yonedarepo-dev-bench");
        live.domains.clear();
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "d1", "yonedarepo-dev-platform-index"),
            Action::Create
        );
        assert_eq!(
            action(&rows, "worker", "yonedarepo-dev-bench"),
            Action::Create
        );
        assert_eq!(
            action(&rows, "domain", "dev.yonedarepo.com"),
            Action::Create
        );
        assert_eq!(
            creations(&rows),
            [
                Create::D1("yonedarepo-dev-platform-index".into()),
                Create::R2("yonedarepo-dev-platform-objects".into()),
                Create::Queue("yonedarepo-dev-platform-dead-letter".into()),
            ]
        );
    }

    #[test]
    fn changed_settings_bindings_and_identities_are_drift() {
        let (spec, lock, workers, mut live) = matching();
        live.d1
            .insert("yonedarepo-dev-platform-index".into(), "other-id".into());
        let platform = live.workers.get_mut("yonedarepo-dev-platform").unwrap();
        platform.settings["compatibility_date"] = json!("2026-01-01");
        platform.settings["bindings"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name": "ROGUE_MODE", "type": "plain_text", "text": "batch"}));
        platform.migration_tag = Some("v3".into());
        let agents = live.workers.get_mut("yonedarepo-dev-agents").unwrap();
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
            "yonedarepo-dev-platform-checkcontainer".into(),
            json!({"max_instances": 16}),
        );
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "d1", "yonedarepo-dev-platform-index"),
            Action::Drift
        );
        let platform = rows
            .iter()
            .find(|r| r.name == "yonedarepo-dev-platform" && r.kind == "worker")
            .unwrap();
        assert_eq!(platform.action, Action::Drift);
        let declared = workers
            .iter()
            .find(|w| w.name == "yonedarepo-dev-platform")
            .and_then(|w| inventory::last_migration_tag(&w.config))
            .unwrap();
        let tag = format!("DO migration tag: declared {declared}, live v3");
        for needle in [
            "compatibility_date",
            "binding ROGUE_MODE (plain_text) not declared",
            tag.as_str(),
        ] {
            assert!(
                platform.detail.contains(needle),
                "{needle} not in {}",
                platform.detail
            );
        }
        let agents = rows
            .iter()
            .find(|r| r.name == "yonedarepo-dev-agents" && r.kind == "worker")
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
            action(&rows, "container", "yonedarepo-dev-platform-checkcontainer"),
            Action::Drift
        );
    }

    #[test]
    fn deploy_time_vars_and_secret_bindings_are_not_drift() {
        let (spec, lock, workers, mut live) = matching();
        let platform = live.workers.get_mut("yonedarepo-dev-platform").unwrap();
        let bindings = platform.settings["bindings"].as_array_mut().unwrap();
        bindings.push(json!({"name": "BUILD_REVISION", "type": "plain_text", "text": "abc"}));
        bindings.push(json!({"name": "OWNER_TOKEN", "type": "secret_text"}));
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "worker", "yonedarepo-dev-platform"),
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
            action(&rows, "container", "yonedarepo-dev-platform-checkcontainer"),
            Action::Unknown
        );
        assert_eq!(
            action(&rows, "worker", "yonedarepo-dev-agents"),
            Action::Unknown
        );
        assert_eq!(
            action(&rows, "secret", "yonedarepo-dev-agents/OWNER_TOKEN"),
            Action::Unknown
        );
        assert!(creations(&rows).is_empty());
    }

    #[test]
    fn undeclared_resources_under_the_prefix_are_extra() {
        let (spec, lock, workers, mut live) = matching();
        live.workers
            .insert("yonedarepo-dev-scratch".into(), LiveWorker::default());
        live.workers
            .insert("yonedarepo-platform-dev".into(), LiveWorker::default());
        live.r2.insert("yonedarepo-dev-leftover".into());
        let rows = diff(&spec, &lock, &workers, &live);
        assert_eq!(
            action(&rows, "worker", "yonedarepo-dev-scratch"),
            Action::Extra
        );
        assert_eq!(
            action(&rows, "r2", "yonedarepo-dev-leftover"),
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
        .find(|c| c["queue"] == "yonedarepo-dev-platform-checks")
        .unwrap();
    assert_eq!(consumer["max_concurrency"], json!(7));
    let jobs = config["queues"]["consumers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["queue"] == "yonedarepo-dev-platform-jobs")
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
    assert_eq!(Spec::parse(PROD).unwrap().check_instances, Some(4));
}

#[test]
fn job_summary_tables_are_markdown_with_escaped_cells() {
    let md = super::wrangler::markdown(
        "deploy dev at abc",
        &["Worker", "Detail"],
        &[vec!["w".into(), "a | b\nc".into()]],
    );
    assert_eq!(
        md,
        "### deploy dev at abc\n\n| Worker | Detail |\n| --- | --- |\n| w | a \\| b c |\n\n"
    );
}

#[test]
fn production_import_app_has_its_own_identity_and_key_binding() {
    let platform = |text: &str| {
        Spec::parse(text)
            .unwrap()
            .workers
            .into_iter()
            .find(|worker| worker.role == "platform")
            .unwrap()
    };
    let (dev, prod) = (platform(DEV), platform(PROD));
    for worker in [&dev, &prod] {
        let vars = &worker.config["vars"];
        assert!(
            vars["GITHUB_APP_ID"]
                .as_str()
                .and_then(|id| id.parse::<u64>().ok())
                .is_some_and(|id| id > 0),
            "each environment needs a GitHub App identity"
        );
        assert!(
            vars["GITHUB_APP_SLUG"]
                .as_str()
                .is_some_and(|slug| !slug.is_empty())
        );
        assert!(
            worker
                .optional_secrets
                .iter()
                .any(|name| name == "GITHUB_APP_PRIVATE_KEY")
        );
    }
    for name in ["GITHUB_APP_ID", "GITHUB_APP_SLUG"] {
        assert_ne!(
            dev.config["vars"][name], prod.config["vars"][name],
            "dev and prod must not share an import App"
        );
    }
}

/// Prod runs what dev runs. A variable may differ only for the reason given here.
#[test]
fn prod_has_every_switch_dev_has() {
    const OWN: [(&str, &str); 13] = [
        ("EMAIL_FROM", "its own sender"),
        ("ADMIN_NOTIFY_EMAIL", "dev mails nobody"),
        ("ADMIN_ACCOUNTS", "its own operators"),
        ("WATCH_URL", "its own host"),
        ("WATCH_FRONT_URL", "its own host"),
        ("PUBLIC_URL", "its own host"),
        ("SSH_HOST", "its own host"),
        ("SITE_EVENTS_DATASET", "its own dataset"),
        ("WEB_ANALYTICS_TOKEN", "its own site"),
        ("SEO_INDEXING", "only prod is indexed"),
        ("REGION_HINT_TEST", "a dev test"),
        ("GITHUB_APP_ID", "its own import App"),
        ("GITHUB_APP_SLUG", "its own import App"),
    ];
    const DEV_TEST: (&str, &str) = ("PROBE_LANDING", "a dev test: off, and frozen");
    let parse = |text: &str| serde_json::from_str::<serde_json::Value>(text).unwrap();
    let (dev, prod) = (parse(DEV), parse(PROD));
    let vars = |spec: &serde_json::Value, role: &str| {
        let workers = spec["workers"].as_array().unwrap();
        let worker = workers.iter().find(|w| w["role"] == role);
        worker.map(|w| w["config"]["vars"].clone())
    };
    for worker in prod["workers"].as_array().unwrap() {
        let role = worker["role"].as_str().unwrap();
        let Some(in_dev) = vars(&dev, role) else {
            continue;
        };
        let in_prod = &worker["config"]["vars"];
        let empty = serde_json::Map::new();
        let names = |vars: &serde_json::Value| {
            vars.as_object()
                .unwrap_or(&empty)
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        for name in names(&in_dev).into_iter().chain(names(in_prod)) {
            if name == "OPERATION_DETAIL_EVERY" {
                // Dev keeps every detail; production returns to 10% after capture expires.
                assert_eq!(in_dev[&name], "1", "{role}: dev detail capture");
                assert_eq!(in_prod[&name], "10", "{role}: production detail sampling");
                continue;
            }
            let excused = OWN.iter().chain([&DEV_TEST]).any(|(own, _)| *own == name);
            assert!(
                excused || in_dev[&name] == in_prod[&name],
                "{role} {name}: dev {} prod {}",
                in_dev[&name],
                in_prod[&name]
            );
        }
    }
}

#[test]
fn dev_and_prod_share_edge_and_regional_backend_topology() {
    for (text, resource_lock) in [(DEV, DEV_LOCK), (PROD, PROD_LOCK)] {
        let spec = Spec::parse(text).unwrap();
        assert_eq!(spec.cells.len(), 1);
        assert!(spec.cells[0].bound);
        assert_eq!(spec.cells[0].code, "weur");
        let configs = spec.configs(&lock(resource_lock)).unwrap();
        let role = |name: &str| &configs.iter().find(|(w, _)| w.role == name).unwrap().1;
        let front = role("agents");
        let primary_binding = front["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|service| service["binding"] == "PLATFORM")
            .unwrap();
        assert!(
            primary_binding.get("entrypoint").is_none(),
            "placed auth HTTP must target the default fetch handler"
        );
        assert!(
            front.get("placement").is_none(),
            "frontend must run at the edge"
        );
        for config in [front, role("platform"), role("platform-weur")] {
            assert_eq!(config["vars"]["CELLS"], "on");
            assert_eq!(config["vars"]["AUTOMATIC_LOCALITY"], "on");
            assert_eq!(config["vars"]["REGION_SIGNALS"], "on");
        }
        for (name, region) in [
            ("api-enam", "aws:us-east-1"),
            ("platform-weur", "aws:eu-central-1"),
        ] {
            assert_eq!(
                role(name)["placement"],
                json!({"mode":"targeted", "region":region})
            );
        }
        for config in [front, role("platform"), role("platform-weur")] {
            assert_eq!(config["vars"]["GLOBAL_AUTH_LIMITS"], "on");
        }
        let european_service = format!("{}-platform-weur", spec.prefix);
        assert!(
            front["services"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["binding"] == "CELL_WEUR" && s["service"] == european_service)
        );
        assert_eq!(role("platform-weur")["vars"]["CELL_JURISDICTION"], "eu");
        assert_eq!(
            role("platform-weur")["vars"]["REGION_HINT_TEST"],
            role("platform")["vars"]["REGION_HINT_TEST"],
            "the owner-only dev location diagnostic must reach regional repositories"
        );
        for (_, config) in &configs {
            for (name, _) in inventory::d1(config) {
                assert!(
                    name.starts_with(&spec.prefix),
                    "cross-environment database {name}"
                );
            }
        }
    }
}

#[test]
fn imports_have_their_own_class_with_the_disk_and_checks_stay_on_their_price() {
    let prod = include_str!("../../../infra/envs/prod.json");
    let prod_lock = include_str!("../../../infra/envs/prod.lock.json");
    for (text, locked) in [(DEV, DEV_LOCK), (prod, prod_lock)] {
        let spec = Spec::parse(text).unwrap();
        let platform = spec.workers.iter().find(|w| w.role == "platform").unwrap();
        let config = spec.worker_config(platform, &lock(locked)).unwrap();
        let containers = config["containers"].as_array().unwrap();
        let class = |name: &str| containers.iter().find(|c| c["class_name"] == name).unwrap();
        assert_eq!(class("CheckContainer")["instance_type"], "standard-1");
        assert_eq!(class("ImportContainer")["instance_type"], "standard-3");
        assert_eq!(
            class("ImportContainer")["image"],
            class("CheckContainer")["image"]
        );
        let migrations = config["migrations"].as_array().unwrap();
        let import = migrations.iter().position(|m| m["tag"] == "v8").unwrap();
        assert_eq!(
            migrations[import],
            json!({"tag": "v8", "new_sqlite_classes": ["ImportContainer"]})
        );
        assert_eq!(
            migrations[import + 1],
            json!({"tag": "v9", "new_sqlite_classes": ["RepositoryReadCopy"]}),
            "read copies append to the existing class migration history"
        );
        assert_eq!(
            migrations
                .iter()
                .filter(|migration| migration["new_sqlite_classes"]
                    .as_array()
                    .is_some_and(|classes| classes.iter().any(|c| c == "ImportContainer")))
                .count(),
            1,
            "the import class must be introduced exactly once"
        );
    }
}

mod cells {
    use super::*;
    use serde_json::{Value, json};

    fn without_cells() -> Spec {
        let mut spec: Value = serde_json::from_str(DEV).unwrap();
        spec.as_object_mut().unwrap().remove("cells");
        Spec::parse(&spec.to_string()).unwrap()
    }
    fn worker<'a>(spec: &'a Spec, role: &str) -> &'a Value {
        &spec.workers.iter().find(|w| w.role == role).unwrap().config
    }
    fn bound() -> Spec {
        let mut spec: Value = serde_json::from_str(DEV).unwrap();
        spec["cells"][0]["bound"] = json!(true);
        Spec::parse(&spec.to_string()).unwrap()
    }
    fn unbound() -> Spec {
        let mut spec: Value = serde_json::from_str(DEV).unwrap();
        spec["cells"][0]["bound"] = json!(false);
        Spec::parse(&spec.to_string()).unwrap()
    }

    /// The gate of stage R5: a cell adds a Worker, and every Worker that was there is unchanged.
    #[test]
    fn a_cell_changes_no_other_worker() {
        let (with, without) = (unbound(), without_cells());
        let roles = |spec: &Spec| {
            spec.workers
                .iter()
                .map(|w| w.role.clone())
                .collect::<Vec<_>>()
        };
        let mut expected = roles(&without);
        let at = expected.iter().position(|r| r == "platform").unwrap();
        expected.insert(at + 1, "platform-weur".into());
        assert_eq!(roles(&with), expected);
        for old in &without.workers {
            assert_eq!(worker(&with, &old.role), &old.config, "{}", old.role);
        }
    }

    #[test]
    fn shared_class_provider_deploys_before_regional_consumers() {
        for spec in [unbound(), bound()] {
            let pos = |role: &str| spec.workers.iter().position(|w| w.role == role).unwrap();
            assert!(pos("superfan") < pos("platform"));
            assert!(
                pos("platform") < pos("platform-weur"),
                "primary exports must exist before a regional cross-script class binding"
            );
            assert!(pos("platform-weur") < pos("edge"));
            let reverse: Vec<_> = spec.workers.iter().rev().map(|w| w.role.as_str()).collect();
            assert!(
                reverse.iter().position(|r| *r == "platform-weur").unwrap()
                    < reverse.iter().position(|r| *r == "platform").unwrap(),
                "rollback consumers before their shared-class provider"
            );
        }
    }

    #[test]
    fn a_cell_is_the_platform_under_its_own_names() {
        let spec = Spec::parse(DEV).unwrap();
        let cell = worker(&spec, "platform-weur");
        assert_eq!(cell["name"], "{prefix}-platform-weur");
        assert_eq!(cell["main"], worker(&spec, "platform")["main"]);
        assert_eq!(
            cell["placement"],
            json!({"mode":"targeted", "region":"aws:eu-central-1"})
        );
        assert!(cell.get("routes").is_none(), "reached through bindings");
        assert_eq!(cell["vars"]["CELL"], "weur");
        assert_eq!(cell["vars"]["CELLS"], "on");
        assert_eq!(cell["vars"]["CELL_JURISDICTION"], "eu");
        assert_eq!(cell["vars"]["ADMIN_BILLING"], "off");
        assert_eq!(cell["vars"]["SSH_FRONT_DOOR"], "off");
        assert_eq!(
            cell["vars"]["LFS_S3_ENDPOINT"],
            "https://{account_id}.eu.r2.cloudflarestorage.com"
        );
        assert_eq!(
            cell["r2_buckets"],
            json!([{"binding": "OBJECTS", "bucket_name": "{prefix}-platform-objects-weur", "jurisdiction": "eu"}])
        );
        assert_eq!(
            cell["d1_databases"][0]["database_name"],
            "{prefix}-platform-index-weur"
        );
        assert_eq!(
            cell["d1_databases"][1]["database_name"],
            "{prefix}-platform-index"
        );
        assert_eq!(
            cell["queues"]["producers"][0]["queue"],
            "{prefix}-platform-jobs-weur"
        );
        assert_eq!(
            cell["queues"]["consumers"][0]["dead_letter_queue"],
            "{prefix}-platform-dead-letter-weur"
        );
        assert_eq!(
            cell["workflows"][0]["name"],
            "{prefix}-platform-import-weur"
        );
        let accounts = cell["durable_objects"]["bindings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["name"] == "WORKSPACES")
            .unwrap();
        assert_eq!(accounts["script_name"], "{prefix}-platform");
        let classes = cell["migrations"][0]["new_sqlite_classes"]
            .as_array()
            .unwrap();
        assert!(!classes.iter().any(|c| c == "WorkspaceAuthority"));
        let containers = cell["containers"].as_array().unwrap();
        assert_eq!(containers.len(), 3, "no SSH gateway");
        assert!(
            containers
                .iter()
                .all(|c| c["constraints"] == json!({"regions": ["WEUR"], "jurisdiction": "eu"}))
        );
    }

    #[test]
    fn its_resources_are_made_in_its_jurisdiction() {
        let spec = Spec::parse(DEV).unwrap();
        assert_eq!(
            spec.jurisdiction_of("yonedarepo-dev-platform-jobs-weur")
                .as_deref(),
            Some("eu")
        );
        assert_eq!(spec.jurisdiction_of("yonedarepo-dev-platform-jobs"), None);
    }

    #[test]
    fn bound_is_what_lets_the_others_reach_it() {
        let spec = bound();
        let cell = json!({"binding": "CELL_WEUR", "service": "{prefix}-platform-weur"});
        for role in ["platform", "agents", "edge"] {
            assert!(
                worker(&spec, role)["services"]
                    .as_array()
                    .unwrap()
                    .contains(&cell),
                "{role}"
            );
        }
        let index =
            json!({"binding": "INDEX_WEUR", "database_name": "{prefix}-platform-index-weur"});
        assert!(
            worker(&spec, "platform")["d1_databases"]
                .as_array()
                .unwrap()
                .contains(&index)
        );
        assert!(worker(&spec, "agents").get("d1_databases").is_none());
    }

    #[test]
    fn an_ephemeral_copy_has_one_cell() {
        let spec = bound().ephemeral(&Env::Ephemeral("x".into()));
        assert!(spec.cells.is_empty());
        assert!(
            !spec
                .workers
                .iter()
                .any(|w| w.role == "platform-weur" || w.role == "edge")
        );
        let platform = worker(&spec, "platform");
        assert_eq!(platform["d1_databases"].as_array().unwrap().len(), 1);
        assert!(
            !platform["services"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["binding"] == "CELL_WEUR")
        );
    }
}
