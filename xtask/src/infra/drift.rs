//! Declared Worker config vs its live settings: bindings, vars, compatibility, DO migration
//! tag and the settings wrangler deploys. Each difference is one human-readable line.
use super::inventory::last_migration_tag;
use super::live::LiveWorker;
use serde_json::Value;
use std::collections::BTreeMap;

/// Vars set at deploy time rather than in the spec.
const DEPLOY_VARS: [&str; 1] = ["BUILD_REVISION"];

fn items<'a>(config: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    config[key].as_array().into_iter().flatten()
}
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Binding name -> target the spec declares (bucket, queue, class, service, value...).
pub(crate) fn declared_bindings(config: &Value) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut add = |name: &Value, target: String| {
        if let Some(name) = name.as_str() {
            out.insert(name.to_owned(), target);
        }
    };
    if let Some(vars) = config["vars"].as_object() {
        for (name, value) in vars {
            add(&Value::String(name.clone()), text(value));
        }
    }
    for b in items(config, "r2_buckets") {
        add(&b["binding"], text(&b["bucket_name"]));
    }
    for b in items(config, "d1_databases") {
        add(&b["binding"], text(&b["database_id"]));
    }
    for b in config["queues"]["producers"]
        .as_array()
        .into_iter()
        .flatten()
    {
        add(&b["binding"], text(&b["queue"]));
    }
    for b in config["durable_objects"]["bindings"]
        .as_array()
        .into_iter()
        .flatten()
    {
        let target = match b["script_name"].as_str() {
            Some(script) => format!("{}@{script}", text(&b["class_name"])),
            None => text(&b["class_name"]),
        };
        add(&b["name"], target);
    }
    for b in items(config, "services") {
        add(&b["binding"], text(&b["service"]));
    }
    for b in items(config, "secrets_store_secrets") {
        add(
            &b["binding"],
            format!("{}/{}", text(&b["store_id"]), text(&b["secret_name"])),
        );
    }
    for b in items(config, "workflows") {
        add(&b["binding"], text(&b["name"]));
    }
    for b in items(config, "ratelimits") {
        add(&b["name"], text(&b["namespace_id"]));
    }
    for b in items(config, "artifacts") {
        add(&b["binding"], text(&b["namespace"]));
    }
    for b in items(config, "worker_loaders") {
        add(&b["binding"], String::new());
    }
    add(&config["assets"]["binding"], String::new());
    out
}

/// The comparable target of a live binding; empty when its type has none we compare.
fn live_target(binding: &Value) -> String {
    match binding["type"].as_str().unwrap_or("") {
        "plain_text" => text(&binding["text"]),
        "json" => text(&binding["json"]),
        "r2_bucket" => text(&binding["bucket_name"]),
        "d1" => text(if binding["id"].is_null() {
            &binding["database_id"]
        } else {
            &binding["id"]
        }),
        "queue" => text(&binding["queue_name"]),
        "durable_object_namespace" => match binding["script_name"].as_str() {
            Some(script) => format!("{}@{script}", text(&binding["class_name"])),
            None => text(&binding["class_name"]),
        },
        "service" => text(&binding["service"]),
        "secrets_store_secret" => format!(
            "{}/{}",
            text(&binding["store_id"]),
            text(&binding["secret_name"])
        ),
        "workflow" => text(&binding["workflow_name"]),
        "ratelimit" => text(&binding["namespace_id"]),
        "artifacts" => text(&binding["namespace"]),
        _ => String::new(),
    }
}

pub(crate) fn binding_drift(config: &Value, settings: &Value) -> Vec<String> {
    let declared = declared_bindings(config);
    let mut lines = Vec::new();
    let live: BTreeMap<String, &Value> = settings["bindings"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| Some((b["name"].as_str()?.to_owned(), b)))
        .collect();
    for (name, target) in &declared {
        match live.get(name) {
            None => lines.push(format!("binding {name} missing")),
            Some(binding) => {
                let found = live_target(binding);
                // A self-referencing DO binding may be reported with the script name.
                let same = found == *target || found.split('@').next() == Some(target.as_str());
                if !found.is_empty() && !target.is_empty() && !same {
                    lines.push(format!(
                        "binding {name}: declared {target:?}, live {found:?}"
                    ));
                }
            }
        }
    }
    for (name, binding) in &live {
        let kind = binding["type"].as_str().unwrap_or("?");
        if !declared.contains_key(name)
            && kind != "secret_text"
            && !DEPLOY_VARS.contains(&name.as_str())
        {
            lines.push(format!("binding {name} ({kind}) not declared"));
        }
    }
    lines
}

pub(crate) fn worker_drift(config: &Value, live: &LiveWorker) -> Vec<String> {
    let settings = &live.settings;
    let mut lines = binding_drift(config, settings);
    let mut compare = |label: &str, declared: &Value, found: &Value| {
        if !declared.is_null() && declared != found {
            lines.push(format!("{label}: declared {declared}, live {found}"));
        }
    };
    compare(
        "compatibility_date",
        &config["compatibility_date"],
        &settings["compatibility_date"],
    );
    compare(
        "compatibility_flags",
        &config["compatibility_flags"],
        &settings["compatibility_flags"],
    );
    compare(
        "observability.enabled",
        &config["observability"]["enabled"],
        &settings["observability"]["enabled"],
    );
    compare(
        "placement.mode",
        &config["placement"]["mode"],
        &settings["placement"]["mode"],
    );
    for (key, value) in config["limits"].as_object().into_iter().flatten() {
        compare(&format!("limits.{key}"), value, &settings["limits"][key]);
    }
    let tails: Vec<Value> = items(config, "tail_consumers")
        .map(|t| t["service"].clone())
        .collect();
    let live_tails: Vec<Value> = items(settings, "tail_consumers")
        .map(|t| t["service"].clone())
        .collect();
    if tails != live_tails && !(tails.is_empty() && settings["tail_consumers"].is_null()) {
        lines.push(format!(
            "tail_consumers: declared {tails:?}, live {live_tails:?}"
        ));
    }
    if let Some(tag) = last_migration_tag(config)
        && live.migration_tag.as_deref() != Some(tag.as_str())
    {
        lines.push(format!(
            "DO migration tag: declared {tag}, live {:?}",
            live.migration_tag
        ));
    }
    if let (Some(declared), Some(found)) = (config["workers_dev"].as_bool(), live.workers_dev)
        && declared != found
    {
        lines.push(format!("workers_dev: declared {declared}, live {found}"));
    }
    lines
}
