//! What an environment used to run. `infra plan` lists live resources with these names as
//! `orphan` rows and `infra prune` deletes exactly those rows, never one a current spec binds.
//!
//! Names are per kind and exact, except for one optional old prefix (`<prefix>` or
//! `<prefix>-…`). Prod's old layout is named `yonedarepo-dev*`, which the dev env takes over
//! after the cutover, so prod lists exact names only.
use super::inventory::{self, Deployable};
use super::live::Live;
use super::plan::{Action, Row};
use super::spec::{Env, Lock, Spec};
use crate::process::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Retired {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// Old naming prefix: a resource of any kind named `<prefix>` or `<prefix>-…`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default)]
    pub workers: BTreeSet<String>,
    /// Container application names (`<worker>-<class in lowercase>`).
    #[serde(default)]
    pub containers: BTreeSet<String>,
    #[serde(default)]
    pub queues: BTreeSet<String>,
    #[serde(default)]
    pub workflows: BTreeSet<String>,
    #[serde(default)]
    pub d1: BTreeSet<String>,
    #[serde(default)]
    pub r2: BTreeSet<String>,
    /// Artifacts namespaces. They cannot be deleted; prune deletes their repositories.
    #[serde(default)]
    pub artifacts: BTreeSet<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    Worker,
    Container,
    Workflow,
    Queue,
    D1,
    R2,
    Artifacts,
}

impl Kind {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Worker => "worker",
            Self::Container => "container",
            Self::Workflow => "workflow",
            Self::Queue => "queue",
            Self::D1 => "d1",
            Self::R2 => "r2",
            Self::Artifacts => "artifacts",
        }
    }
    pub(crate) fn from_label(label: &str) -> Option<Self> {
        [
            Self::Worker,
            Self::Container,
            Self::Workflow,
            Self::Queue,
            Self::D1,
            Self::R2,
            Self::Artifacts,
        ]
        .into_iter()
        .find(|k| k.label() == label)
    }
}

impl Retired {
    pub(crate) fn is_empty(&self) -> bool {
        *self == Self::default()
    }
    fn names(&self, kind: Kind) -> &BTreeSet<String> {
        match kind {
            Kind::Worker => &self.workers,
            Kind::Container => &self.containers,
            Kind::Workflow => &self.workflows,
            Kind::Queue => &self.queues,
            Kind::D1 => &self.d1,
            Kind::R2 => &self.r2,
            Kind::Artifacts => &self.artifacts,
        }
    }
    pub(crate) fn matches(&self, kind: Kind, name: &str) -> bool {
        let by_prefix = self.prefix.as_deref().is_some_and(|p| {
            name == p
                || name
                    .strip_prefix(p)
                    .is_some_and(|rest| rest.starts_with('-'))
        });
        by_prefix || self.names(kind).contains(name)
    }
}

/// Every (kind, name) the given Workers declare or reach: their own names and container apps,
/// queues, workflows, D1, R2, Artifacts namespaces, and the Workers they bind or tail.
pub(crate) fn declared(workers: &[Deployable]) -> BTreeSet<(Kind, String)> {
    let mut out = BTreeSet::new();
    let strings = |config: &Value, pointer: &str, field: &str| -> Vec<String> {
        config
            .pointer(pointer)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|v| v[field].as_str().map(str::to_owned))
            .collect()
    };
    for w in workers {
        let c = &w.config;
        out.insert((Kind::Worker, w.name.clone()));
        for name in strings(c, "/services", "service")
            .into_iter()
            .chain(strings(c, "/tail_consumers", "service"))
            .chain(strings(c, "/durable_objects/bindings", "script_name"))
        {
            out.insert((Kind::Worker, name));
        }
        let mut add = |kind: Kind, names: BTreeSet<String>| {
            out.extend(names.into_iter().map(|n| (kind, n)));
        };
        add(
            Kind::Container,
            inventory::containers(c).into_keys().collect(),
        );
        add(Kind::Queue, inventory::queues(c));
        add(Kind::Workflow, inventory::workflows(c));
        add(
            Kind::D1,
            inventory::d1(c).into_iter().map(|(n, _)| n).collect(),
        );
        add(Kind::R2, inventory::r2(c));
        add(Kind::Artifacts, inventory::artifacts_namespaces(c));
    }
    out
}

/// Everything the committed dev and prod specs declare, plus `workers` (the env at hand,
/// which may be an ephemeral copy). Prune never deletes one of these.
pub(crate) fn protected(workers: &[Deployable]) -> Result<BTreeSet<(Kind, String)>> {
    let mut out = declared(workers);
    for env in [Env::Dev, Env::Prod] {
        let spec = Spec::load(&env)?;
        let lock = super::plan::effective_lock(&spec, &Lock::load(&env)?, &Live::default())?;
        out.extend(declared(&inventory::deployables(&spec, &lock)?));
    }
    Ok(out)
}

/// Live resources the retired list names. A retired name that a current spec still declares
/// is shown as DRIFT (prune refuses to run while one exists), never as an orphan.
pub(crate) fn orphans(
    retired: &Retired,
    protected: &BTreeSet<(Kind, String)>,
    live: &Live,
) -> Vec<Row> {
    if retired.is_empty() {
        return Vec::new();
    }
    let mut rows = Vec::new();
    let mut check = |kind: Kind, name: &str, detail: String| {
        if !retired.matches(kind, name) {
            return;
        }
        let (action, detail) = if protected.contains(&(kind, name.to_owned())) {
            (
                Action::Drift,
                "retired name, but a current spec binds it; prune refuses".to_owned(),
            )
        } else {
            (Action::Orphan, detail)
        };
        rows.push(Row {
            kind: kind.label(),
            name: name.to_owned(),
            action,
            detail,
        });
    };
    for name in live.workers.keys() {
        let consumes: Vec<&str> = live
            .queues
            .iter()
            .filter(|(_, scripts)| scripts.contains(name))
            .map(|(queue, _)| queue.as_str())
            .collect();
        let detail = if consumes.is_empty() {
            String::new()
        } else {
            format!("consumes {}", consumes.join(", "))
        };
        check(Kind::Worker, name, detail);
    }
    for (name, app) in &live.containers {
        check(
            Kind::Container,
            name,
            app["id"]
                .as_str()
                .map(|id| format!("app {id}"))
                .unwrap_or_default(),
        );
    }
    for name in &live.workflows {
        check(Kind::Workflow, name, String::new());
    }
    for name in live.queues.keys() {
        check(Kind::Queue, name, String::new());
    }
    for (name, id) in &live.d1 {
        check(Kind::D1, name, id.clone());
    }
    for name in &live.r2 {
        check(Kind::R2, name, "deleted only when empty".into());
    }
    // An emptied namespace stays listed; only one that still holds repositories is an orphan.
    for (namespace, repos) in live.artifacts.iter().filter(|(_, r)| !r.is_empty()) {
        check(
            Kind::Artifacts,
            namespace,
            format!("{} repositories", repos.len()),
        );
    }
    rows
}

/// The repositories of every retired Artifacts namespace that exists (wrangler's login reads
/// them; there is no REST listing in this tool).
pub(crate) fn read_artifacts(spec: &Spec, live: &mut Live) {
    if spec.retired.artifacts.is_empty() && spec.retired.prefix.is_none() {
        return;
    }
    let read = || -> Result<BTreeMap<String, Vec<String>>> {
        let listing: Value = serde_json::from_slice(&super::wrangler::output(
            &spec.account_id,
            &["artifacts", "namespaces", "list", "--json"],
        )?)?;
        let mut out = BTreeMap::new();
        for namespace in listing
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| n["name"].as_str())
            .filter(|n| spec.retired.matches(Kind::Artifacts, n))
        {
            out.insert(
                namespace.to_owned(),
                artifacts_repos(&spec.account_id, namespace)?,
            );
        }
        Ok(out)
    };
    match read() {
        Ok(found) => live.artifacts = found,
        Err(error) => live.errors.push(format!("Artifacts: {error}")),
    }
}

/// Repository names in one Artifacts namespace.
pub(crate) fn artifacts_repos(account: &str, namespace: &str) -> Result<Vec<String>> {
    let listing: Value = serde_json::from_slice(&super::wrangler::output(
        account,
        &[
            "artifacts",
            "repos",
            "list",
            "--namespace",
            namespace,
            "--json",
        ],
    )?)?;
    Ok(listing
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["name"].as_str().map(str::to_owned))
        .collect())
}
