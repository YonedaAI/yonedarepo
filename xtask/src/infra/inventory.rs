//! What an expanded wrangler config declares: resources, routes, health URL.
use super::spec::{Lock, Spec, WorkerSpec};
use crate::process::Result;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

fn items<'a>(config: &'a Value, pointer: &str) -> impl Iterator<Item = &'a Value> {
    config
        .pointer(pointer)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

fn strings<'a>(config: &'a Value, pointer: &str, field: &'a str) -> impl Iterator<Item = &'a str> {
    items(config, pointer).filter_map(move |v| v[field].as_str())
}

pub(crate) fn worker_name(config: &Value) -> Result<&str> {
    config["name"]
        .as_str()
        .ok_or_else(|| "Worker config without a name".into())
}

/// One deployable Worker of an environment, in cutover order.
#[derive(Clone, Debug)]
pub(crate) struct Deployable {
    pub name: String,
    pub role: String,
    /// Config path relative to the workspace root.
    pub config_path: String,
    pub config: Value,
    pub secrets: Vec<String>,
    pub health: Option<(String, String)>,
    pub has_containers: bool,
}

pub(crate) fn deployables(spec: &Spec, lock: &Lock) -> Result<Vec<Deployable>> {
    spec.configs(lock)?
        .into_iter()
        .map(|(worker, config)| deployable(spec, &worker, config))
        .collect()
}

fn deployable(spec: &Spec, worker: &WorkerSpec, config: Value) -> Result<Deployable> {
    let name = worker_name(&config)?.to_owned();
    let health = match &worker.health {
        Some(service) => Some((
            health_origin(spec, &config)
                .ok_or_else(|| format!("{name} reports /health but has no public hostname"))?,
            service.clone(),
        )),
        None => None,
    };
    let has_containers = items(&config, "/containers").next().is_some();
    Ok(Deployable {
        role: worker.role.clone(),
        config_path: format!("{}/{}", super::spec::CONFIG_DIR, worker.file),
        has_containers,
        secrets: worker.secrets.clone(),
        health,
        name,
        config,
    })
}

/// A custom domain wins; otherwise the workers.dev hostname when it is enabled.
pub(crate) fn health_origin(spec: &Spec, config: &Value) -> Option<String> {
    if let Some(domain) = routes(config).into_iter().find(|r| r.custom_domain) {
        return Some(format!("https://{}", domain.pattern));
    }
    let name = config["name"].as_str()?;
    (config["workers_dev"] == Value::Bool(true))
        .then(|| format!("https://{name}.{}.workers.dev", spec.workers_subdomain))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Route {
    pub pattern: String,
    pub custom_domain: bool,
}

pub(crate) fn routes(config: &Value) -> Vec<Route> {
    items(config, "/routes")
        .filter_map(|r| {
            Some(Route {
                pattern: r["pattern"].as_str()?.to_owned(),
                custom_domain: r["custom_domain"] == Value::Bool(true),
            })
        })
        .collect()
}

/// D1 databases with their migrations directory relative to the workspace root.
pub(crate) fn d1(config: &Value) -> Vec<(String, Option<String>)> {
    items(config, "/d1_databases")
        .filter_map(|d| {
            let dir = d["migrations_dir"]
                .as_str()
                .map(|dir| format!("{}/{dir}", super::spec::CONFIG_DIR));
            Some((d["database_name"].as_str()?.to_owned(), dir))
        })
        .collect()
}

pub(crate) fn r2(config: &Value) -> BTreeSet<String> {
    strings(config, "/r2_buckets", "bucket_name")
        .map(str::to_owned)
        .collect()
}

/// Every queue the config names (producers, consumers, dead-letter queues).
pub(crate) fn queues(config: &Value) -> BTreeSet<String> {
    strings(config, "/queues/producers", "queue")
        .chain(strings(config, "/queues/consumers", "queue"))
        .chain(strings(config, "/queues/consumers", "dead_letter_queue"))
        .map(str::to_owned)
        .collect()
}

pub(crate) fn dead_letter_queues(config: &Value) -> BTreeSet<String> {
    strings(config, "/queues/consumers", "dead_letter_queue")
        .map(str::to_owned)
        .collect()
}

pub(crate) fn artifacts_namespaces(config: &Value) -> BTreeSet<String> {
    strings(config, "/artifacts", "namespace")
        .map(str::to_owned)
        .collect()
}

pub(crate) fn consumers(config: &Value) -> BTreeSet<String> {
    strings(config, "/queues/consumers", "queue")
        .map(str::to_owned)
        .collect()
}

pub(crate) fn workflows(config: &Value) -> BTreeSet<String> {
    strings(config, "/workflows", "name")
        .map(str::to_owned)
        .collect()
}

/// Container application name -> declared config. Wrangler names an application
/// `<worker>-<class in lowercase>`.
pub(crate) fn containers(config: &Value) -> BTreeMap<String, Value> {
    let worker = config["name"].as_str().unwrap_or_default();
    items(config, "/containers")
        .filter_map(|c| {
            let class = c["class_name"].as_str()?;
            Some((format!("{worker}-{}", class.to_lowercase()), c.clone()))
        })
        .collect()
}

/// The container applications that run the shared runtime image. A Durable Object-managed
/// container with its own named `images` (the sandbox agent) is built by wrangler from its
/// own Dockerfile and never takes the runtime image.
pub(crate) fn runtime_containers(config: &Value) -> BTreeMap<String, Value> {
    containers(config)
        .into_iter()
        .filter(|(_, c)| c.get("images").is_none())
        .collect()
}

pub(crate) fn last_migration_tag(config: &Value) -> Option<String> {
    items(config, "/migrations")
        .last()
        .and_then(|m| m["tag"].as_str())
        .map(str::to_owned)
}
