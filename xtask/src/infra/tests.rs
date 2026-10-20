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
            "wrangler.staging-platform.jsonc",
            "wrangler.staging-agents.jsonc",
            "wrangler.staging-sites.jsonc",
            "wrangler.staging-superfan.jsonc"
        ],
        "cutover order: platform, agents, sites, then the watcher"
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
    let error = spec
        .worker_config(&spec.workers[0], &Lock::default())
        .unwrap_err();
    assert!(error.to_string().contains("not in the lock"), "{error}");
    let mut bad = spec.clone();
    bad.workers[0].config["vars"]["X"] = json!("{nope}");
    let error = bad
        .worker_config(&bad.workers[0], &lock(DEV_LOCK))
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
    let platform = &workers[0];
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
        workers[1].health.as_ref().unwrap().0,
        "https://dev.yonedarepo.com"
    );
    assert_eq!(workers[2].health, None);
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
