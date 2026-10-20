//! Declarative environment specs (`infra/envs/<env>.json`) and their resource locks.
//!
//! A spec holds one wrangler config fragment per Worker, in cutover order. Strings may use
//! `{prefix}`, `{account_id}`, `{subdomain}`, `{zone}` and the spec's own `vars`; D1
//! `database_id`s come from the lock, so resource identities are never hand-edited.
use crate::process::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub(crate) const SPEC_DIR: &str = "infra/envs";
/// Generated configs live next to the hand-written ones, so relative paths stay identical.
pub(crate) const CONFIG_DIR: &str = "cloudflare";
const EPHEMERAL_RATE_LIMIT: &str = "2900";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Env {
    Dev,
    Prod,
    /// A throwaway full stack on workers.dev hostnames with its own resources.
    Ephemeral(String),
}

impl Env {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "dev" => Ok(Self::Dev),
            "prod" => Ok(Self::Prod),
            other => match other.strip_prefix("ephemeral-") {
                Some(id)
                    if !id.is_empty()
                        && id.len() <= 12
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) =>
                {
                    Ok(Self::Ephemeral(id.into()))
                }
                _ => Err(format!(
                    "Unknown environment {other:?}: use dev, prod or ephemeral-<id> (id: 1-12 lowercase letters or digits)"
                )
                .into()),
            },
        }
    }
    pub(crate) fn from_args(args: &[String]) -> Result<Self> {
        let value = args
            .windows(2)
            .find(|v| v[0] == "--env")
            .map(|v| v[1].as_str())
            .ok_or("Missing --env dev|prod|ephemeral-<id>")?;
        Self::parse(value)
    }
    pub(crate) fn name(&self) -> String {
        match self {
            Self::Dev => "dev".into(),
            Self::Prod => "prod".into(),
            Self::Ephemeral(id) => format!("ephemeral-{id}"),
        }
    }
    pub(crate) fn is_prod(&self) -> bool {
        *self == Self::Prod
    }
    /// Local state of an ephemeral env (lock, generated secrets); ignored by Git.
    pub(crate) fn state_dir(&self) -> PathBuf {
        PathBuf::from(".local/infra").join(self.name())
    }
    pub(crate) fn lock_path(&self) -> PathBuf {
        match self {
            Self::Ephemeral(_) => self.state_dir().join("lock.json"),
            _ => PathBuf::from(SPEC_DIR).join(format!("{}.lock.json", self.name())),
        }
    }
}

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
    pub workers: Vec<WorkerSpec>,
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
    pub config: Value,
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
        for worker in &mut self.workers {
            worker.file = format!("wrangler.{}-{}.jsonc", env.name(), worker.role);
            worker.notes = vec![format!(
                "Ephemeral stack {}: removed by `cargo xtask infra down --env {} --confirm --purge`.",
                env.name(),
                env.name()
            )];
            if let Some(config) = worker.config.as_object_mut() {
                config.remove("routes");
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
    fn substitutions(&self) -> BTreeMap<String, String> {
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
    pub(crate) fn configs(&self, lock: &Lock) -> Result<Vec<(WorkerSpec, Value)>> {
        self.workers
            .iter()
            .map(|w| Ok((w.clone(), self.worker_config(w, lock)?)))
            .collect()
    }
}

fn expand(value: &mut Value, vars: &BTreeMap<String, String>) -> Result<()> {
    match value {
        Value::String(text) => *text = substitute(text, vars)?,
        Value::Array(items) => {
            for item in items {
                expand(item, vars)?;
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                expand(item, vars)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn substitute(text: &str, vars: &BTreeMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        let end = tail
            .find('}')
            .ok_or_else(|| format!("Unclosed template in {text:?}"))?;
        let key = &tail[..end];
        out.push_str(
            vars.get(key)
                .ok_or_else(|| format!("Unknown template {{{key}}} in {text:?}"))?,
        );
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}
