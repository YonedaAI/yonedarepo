//! Declarative environment specs (`infra/envs/<env>.json`) and their resource locks.
//!
//! A spec holds one wrangler config fragment per Worker, in cutover order. Strings may use
//! `{prefix}`, `{account_id}`, `{subdomain}`, `{zone}` and the spec's own `vars`; D1
//! `database_id`s come from the lock, so resource identities are never hand-edited.
use super::retired::Retired;
use super::template::{expand, substitute};
use crate::process::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub(crate) use super::env::Env;

pub(crate) const SPEC_DIR: &str = "infra/envs";
/// Generated configs live next to the hand-written ones, so relative paths stay identical.
pub(crate) const CONFIG_DIR: &str = "cloudflare";
const EPHEMERAL_RATE_LIMIT: &str = "2900";
/// Lock entry of a D1 database the spec declares but `infra up` has not created yet. Configs
/// generate with it; a deploy refuses it (deploy_env::run).
pub(crate) const PENDING_D1: &str = "pending";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct Spec {
    pub env: String,
    pub account_id: String,
    pub zone: String,
    pub workers_subdomain: String,
    pub prefix: String,
    /// The branch whose tip may deploy here; `None` means any clean commit.
    #[serde(default, rename = "ref")]
    pub git_ref: Option<String>,
    /// KEY=VALUE file with the Worker secrets; `~/` expands to the home directory.
    pub secrets_file: String,
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
    /// CheckContainer max_instances, and the max_concurrency of the queue consumer that feeds
    /// it (PLATFORM_CHECKS): one number, so checks never queue behind idle capacity.
    #[serde(default)]
    pub check_instances: Option<u64>,
    pub workers: Vec<WorkerSpec>,
    /// The env's previous names: `infra plan` orphans, deleted by `infra prune`.
    #[serde(default, skip_serializing_if = "Retired::is_empty")]
    pub retired: Retired,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct WorkerSpec {
    pub role: String,
    /// Config file name inside `cloudflare/`.
    pub file: String,
    /// Header comment of the generated file.
    #[serde(default)]
    pub notes: Vec<String>,
    /// Secret names this Worker needs; values come from `secrets_file`.
    #[serde(default)]
    pub secrets: Vec<String>,
    /// The `service` its `/health` reports, when it serves one.
    #[serde(default)]
    pub health: Option<String>,
    /// Whether ephemeral copies of this env include the Worker (operations-only Workers,
    /// such as a watcher wired to one env's resource ids, opt out).
    #[serde(default = "yes")]
    pub ephemeral: bool,
    /// Container classes that stay up without work (the SSH gateway keeps its tunnel open),
    /// each with what a rollout drops: the busy-container gates do not count them, since a
    /// rollout kills no runs on them.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub always_on: BTreeMap<String, String>,
    pub config: Value,
}

fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct Lock {
    /// D1 database name -> UUID.
    #[serde(default)]
    pub d1: BTreeMap<String, String>,
}

impl Lock {
    pub(crate) fn load(env: &Env) -> Result<Self> {
        let path = env.lock_path();
        if !path.exists() {
            return Ok(Self::default());
        }
        serde_json::from_slice(&std::fs::read(&path)?)
            .map_err(|error| format!("Invalid lock {}: {error}", path.display()).into())
    }
    pub(crate) fn save(&self, env: &Env) -> Result<()> {
        let path = env.lock_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(self)?))?;
        Ok(())
    }
}

impl Spec {
    pub(crate) fn load(env: &Env) -> Result<Self> {
        let source = match env {
            Env::Ephemeral(_) => Env::Dev,
            other => other.clone(),
        };
        let path = PathBuf::from(SPEC_DIR).join(format!("{}.json", source.name()));
        let spec = Self::parse(&std::fs::read_to_string(&path)?)
            .map_err(|error| format!("Invalid spec {}: {error}", path.display()))?;
        match env {
            Env::Ephemeral(_) => Ok(spec.ephemeral(env)),
            _ => Ok(spec),
        }
    }
    pub(crate) fn parse(text: &str) -> Result<Self> {
        let spec: Self = serde_json::from_str(text)?;
        if spec.workers.is_empty() {
            return Err("A spec needs at least one Worker".into());
        }
        Ok(spec)
    }
    /// The dev stack under its own prefix: workers.dev only, its own resources and secrets,
    /// one container instance per class.
    pub(crate) fn ephemeral(mut self, env: &Env) -> Self {
        let prefix = format!("yonedarepo-{}", env.name().replace("ephemeral", "eph"));
        self.env = env.name();
        self.git_ref = None;
        self.secrets_file = env.state_dir().join("secrets.env").display().to_string();
        self.vars
            .insert("ratelimit".into(), EPHEMERAL_RATE_LIMIT.into());
        self.vars.insert(
            "origin".into(),
            format!(
                "https://{prefix}-agents.{}.workers.dev",
                self.workers_subdomain
            ),
        );
        self.prefix = prefix;
        self.workers.retain(|w| w.ephemeral);
        self.retired = Retired::default();
        self.check_instances = self.check_instances.map(|_| 1);
        for worker in &mut self.workers {
            worker.file = format!("wrangler.{}-{}.jsonc", env.name(), worker.role);
            // Its generated secrets file has no R2 S3 key pair: Git LFS answers 501 there.
            worker.secrets.retain(|s| !s.starts_with("LFS_S3_"));
            worker.notes = vec![format!(
                "Ephemeral stack {}: removed by `cargo xtask infra down --env {} --confirm --purge`.",
                env.name(),
                env.name()
            )];
            if let Some(config) = worker.config.as_object_mut() {
                config.remove("routes");
                config.remove("tail_consumers");
                config.insert("workers_dev".into(), json!(true));
                if let Some(containers) = config.get_mut("containers").and_then(Value::as_array_mut)
                {
                    for container in containers {
                        container["max_instances"] = json!(1);
                    }
                }
            }
        }
        self
    }
    pub(crate) fn secrets_path(&self) -> PathBuf {
        match (
            self.secrets_file.strip_prefix("~/"),
            std::env::var_os("HOME"),
        ) {
            (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
            _ => PathBuf::from(&self.secrets_file),
        }
    }
    pub(crate) fn substitutions(&self) -> BTreeMap<String, String> {
        let mut values = self.vars.clone();
        values.insert("prefix".into(), self.prefix.clone());
        values.insert("account_id".into(), self.account_id.clone());
        values.insert("subdomain".into(), self.workers_subdomain.clone());
        values.insert("zone".into(), self.zone.clone());
        values
    }
    /// The complete wrangler config of one Worker: templates expanded, account and D1
    /// identities filled in. Fails on an unknown template or a D1 database not in the lock.
    pub(crate) fn worker_config(&self, worker: &WorkerSpec, lock: &Lock) -> Result<Value> {
        let mut config = worker.config.clone();
        expand(&mut config, &self.substitutions())?;
        let object = config
            .as_object_mut()
            .ok_or_else(|| format!("Worker {} config is not an object", worker.role))?;
        object.insert(
            "$schema".into(),
            json!("../node_modules/wrangler/config-schema.json"),
        );
        object.insert("account_id".into(), json!(self.account_id));
        derive_checks(object, self.check_instances)?;
        if let Some(databases) = object.get_mut("d1_databases").and_then(Value::as_array_mut) {
            for database in databases {
                let name = database["database_name"]
                    .as_str()
                    .ok_or("D1 entry without database_name")?;
                let id = lock.d1.get(name).ok_or_else(|| {
                    format!("D1 {name} is not in the lock; run `cargo xtask infra up --env {}` to create it", self.env)
                })?;
                database["database_id"] = json!(id);
            }
        }
        Ok(config)
    }
    /// Worker names in cutover order, templates expanded.
    pub(crate) fn worker_names(&self) -> Result<Vec<String>> {
        let vars = self.substitutions();
        self.workers
            .iter()
            .map(|w| {
                substitute(
                    w.config["name"].as_str().ok_or("Worker without a name")?,
                    &vars,
                )
            })
            .collect()
    }
    /// Every D1 database name the spec declares, templates expanded.
    pub(crate) fn d1_names(&self) -> Result<Vec<String>> {
        let vars = self.substitutions();
        let mut names = Vec::new();
        for worker in &self.workers {
            for database in worker.config["d1_databases"]
                .as_array()
                .into_iter()
                .flatten()
            {
                if let Some(name) = database["database_name"].as_str() {
                    names.push(substitute(name, &vars)?);
                }
            }
        }
        Ok(names)
    }
    pub(crate) fn configs(&self, lock: &Lock) -> Result<Vec<(WorkerSpec, Value)>> {
        self.workers
            .iter()
            .map(|w| Ok((w.clone(), self.worker_config(w, lock)?)))
            .collect()
    }
}

const CHECK_CLASS: &str = "CheckContainer";
const CHECK_QUEUE_BINDING: &str = "PLATFORM_CHECKS";

/// Writes `check_instances` into the CheckContainer and its queue consumer.
fn derive_checks(
    config: &mut serde_json::Map<String, Value>,
    instances: Option<u64>,
) -> Result<()> {
    let has_checks = config
        .get("containers")
        .and_then(Value::as_array)
        .is_some_and(|list| list.iter().any(|c| c["class_name"] == CHECK_CLASS));
    if !has_checks {
        return Ok(());
    }
    let n = instances.ok_or("A Worker runs CheckContainer, so the spec needs check_instances")?;
    for container in config
        .get_mut("containers")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if container["class_name"] == CHECK_CLASS {
            container["max_instances"] = json!(n);
        }
    }
    let queue = config["queues"]["producers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["binding"] == CHECK_QUEUE_BINDING)
        .and_then(|p| p["queue"].as_str())
        .map(str::to_owned)
        .ok_or("CheckContainer without a PLATFORM_CHECKS queue producer")?;
    for consumer in config
        .get_mut("queues")
        .and_then(|q| q.get_mut("consumers"))
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if consumer["queue"] == queue.as_str() {
            consumer["max_concurrency"] = json!(n);
        }
    }
    Ok(())
}
