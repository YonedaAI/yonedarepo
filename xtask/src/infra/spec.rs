//! Declarative environment specs (`infra/envs/<env>.json`) and their resource locks.
//!
//! A spec holds one wrangler config fragment per Worker, in cutover order. Strings may use
//! `{prefix}`, `{account_id}`, `{subdomain}`, `{zone}` and the spec's own `vars`; D1
//! `database_id`s come from the lock, so resource identities are never hand-edited.
use super::api_regions::ApiRegion;
use super::cells::CellSpec;
use super::retired::Retired;
use super::spec_checks::derive_checks;
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
    /// Regions with a whole copy of the platform, each a Worker made from the platform's.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cells: Vec<CellSpec>,
    /// API execution regions; these aliases own no repository storage or jobs.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub api_regions: Vec<ApiRegion>,
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
    /// Secret names that switch a feature on (sign-in providers): uploaded when the secrets
    /// file has them, skipped without failing the deploy when it does not.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub optional_secrets: Vec<String>,
    /// A secret's name in `secrets_file`, where it isn't the Worker's: a cell's own R2 keys.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secret_files: BTreeMap<String, String>,
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
        let mut spec: Self = serde_json::from_str(text)?;
        if spec.workers.is_empty() {
            return Err("A spec needs at least one Worker".into());
        }
        super::cells::expand(&mut spec)?;
        super::api_regions::expand(&mut spec)?;
        Ok(spec)
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
    /// The jurisdiction `resource` must be created in, if a cell fixes one.
    pub(crate) fn jurisdiction_of(&self, resource: &str) -> Option<String> {
        super::cells::jurisdiction_of(self, resource)
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
