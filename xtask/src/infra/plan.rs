//! `infra plan`: declared resources vs live state -> create / unchanged / drift rows.
use super::drift::worker_drift;
use super::inventory::{self, Deployable};
use super::live::Live;
use super::retired::{self, Kind};
use super::spec::{Env, Lock, PENDING_D1, Spec};
use super::wrangler::table;
use crate::process::Result;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Create,
    Unchanged,
    Drift,
    /// Live, named under the env's prefix, but not declared.
    Extra,
    /// Live under one of the env's retired names (spec `retired`); `infra prune` deletes it.
    Orphan,
    /// Its section could not be read; nothing is claimed about it.
    Unknown,
}

impl Action {
    fn label(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Unchanged => "unchanged",
            Self::Drift => "DRIFT",
            Self::Extra => "extra",
            Self::Orphan => "orphan",
            Self::Unknown => "UNVERIFIED",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Row {
    pub kind: &'static str,
    pub name: String,
    pub action: Action,
    pub detail: String,
}

fn row(kind: &'static str, name: &str, action: Action, detail: impl Into<String>) -> Row {
    Row {
        kind,
        name: name.into(),
        action,
        detail: detail.into(),
    }
}

/// The lock a plan or apply works with: recorded ids, else live ids, else "" (to create). A
/// `pending` entry counts as not recorded.
pub(crate) fn effective_lock(spec: &Spec, lock: &Lock, live: &Live) -> Result<Lock> {
    let mut out = Lock::default();
    for name in spec.d1_names()? {
        let id = lock
            .d1
            .get(&name)
            .filter(|id| id.as_str() != PENDING_D1)
            .or(live.d1.get(&name))
            .cloned()
            .unwrap_or_default();
        out.d1.insert(name, id);
    }
    Ok(out)
}

fn failed(live: &Live, section: &str) -> bool {
    live.errors.iter().any(|e| e.starts_with(section))
}

/// Pure diff of the declared env against a live snapshot.
pub(crate) fn diff(spec: &Spec, lock: &Lock, workers: &[Deployable], live: &Live) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut presence = |kind: &'static str, section: &str, name: &str, exists: bool| {
        let action = match (failed(live, section), exists) {
            (true, _) => Action::Unknown,
            (false, true) => Action::Unchanged,
            (false, false) => Action::Create,
        };
        rows.push(row(kind, name, action, ""));
    };
    let mut seen = BTreeSet::new();
    for w in workers {
        for (name, _) in inventory::d1(&w.config) {
            if seen.insert(("d1", name.clone())) {
                presence("d1", "D1", &name, live.d1.contains_key(&name));
            }
        }
        for name in inventory::r2(&w.config) {
            if seen.insert(("r2", name.clone())) {
                presence("r2", "R2", &name, live.r2.contains(&name));
            }
        }
        for name in inventory::queues(&w.config) {
            if seen.insert(("queue", name.clone())) {
                presence("queue", "Queues", &name, live.queues.contains_key(&name));
            }
        }
        for name in inventory::workflows(&w.config) {
            presence(
                "workflow",
                "Workflows",
                &name,
                live.workflows.contains(&name),
            );
        }
    }
    // D1 identities: the lock must name the live database.
    for row in rows
        .iter_mut()
        .filter(|r| r.kind == "d1" && r.action == Action::Unchanged)
    {
        let (recorded, found) = (lock.d1.get(&row.name), live.d1.get(&row.name));
        if recorded != found {
            row.action = Action::Drift;
            row.detail = format!("lock {:?}, live {:?}", recorded, found);
        }
    }
    for w in workers {
        rows.extend(worker_rows(w, live));
    }
    rows.extend(extras(spec, workers, live));
    rows
}

fn worker_rows(w: &Deployable, live: &Live) -> Vec<Row> {
    let mut rows = Vec::new();
    let worker = live.workers.get(&w.name);
    rows.push(match (failed(live, "Workers"), worker) {
        (true, _) => row("worker", &w.name, Action::Unknown, ""),
        (false, None) => row("worker", &w.name, Action::Create, ""),
        (false, Some(found)) => {
            let lines = worker_drift(&w.config, found);
            let action = if lines.is_empty() {
                Action::Unchanged
            } else {
                Action::Drift
            };
            row("worker", &w.name, action, lines.join("; "))
        }
    });
    for secret in &w.secrets {
        let present = worker.is_some_and(|found| found.secrets.contains(secret));
        let action = if failed(live, "Workers") {
            Action::Unknown
        } else if present {
            Action::Unchanged
        } else {
            Action::Create
        };
        rows.push(row("secret", &format!("{}/{secret}", w.name), action, ""));
    }
    for queue in inventory::consumers(&w.config) {
        if failed(live, "Queues") {
            continue;
        }
        if let Some(scripts) = live.queues.get(&queue)
            && !scripts.contains(&w.name)
        {
            rows.push(row(
                "consumer",
                &queue,
                Action::Drift,
                format!("declared {}, live {scripts:?}", w.name),
            ));
        }
    }
    for (app, declared) in inventory::containers(&w.config) {
        let found = live.containers.get(&app);
        let mut lines = Vec::new();
        if let Some(found) = found {
            if found["max_instances"] != declared["max_instances"] {
                lines.push(format!(
                    "max_instances: declared {}, live {}",
                    declared["max_instances"], found["max_instances"]
                ));
            }
            let image = declared["image"].as_str().unwrap_or("");
            if image.starts_with("registry.")
                && found["configuration"]["image"].as_str() != Some(image)
            {
                lines.push(format!("image: live {}", found["configuration"]["image"]));
            }
        }
        let action = match (failed(live, "Containers"), found, lines.is_empty()) {
            (true, _, _) => Action::Unknown,
            (false, None, _) => Action::Create,
            (false, Some(_), true) => Action::Unchanged,
            (false, Some(_), false) => Action::Drift,
        };
        rows.push(row("container", &app, action, lines.join("; ")));
    }
    for route in inventory::routes(&w.config) {
        let (kind, section, found) = if route.custom_domain {
            ("domain", "Custom domains", live.domains.get(&route.pattern))
        } else {
            ("route", "Routes", live.routes.get(&route.pattern))
        };
        let action = match (failed(live, section), found) {
            (true, _) => Action::Unknown,
            (false, None) => Action::Create,
            (false, Some(script)) if *script == w.name => Action::Unchanged,
            (false, Some(_)) => Action::Drift,
        };
        let detail = found
            .filter(|s| **s != w.name)
            .map(|s| format!("serves {s}"))
            .unwrap_or_default();
        rows.push(row(kind, &route.pattern, action, detail));
    }
    rows
}

/// Live Workers and resources under the env's prefix that the spec does not declare.
fn extras(spec: &Spec, workers: &[Deployable], live: &Live) -> Vec<Row> {
    let owned = |name: &str| name == spec.prefix || name.starts_with(&format!("{}-", spec.prefix));
    let mut declared = BTreeSet::new();
    for w in workers {
        declared.insert(w.name.clone());
        declared.extend(inventory::d1(&w.config).into_iter().map(|(n, _)| n));
        declared.extend(inventory::r2(&w.config));
        declared.extend(inventory::queues(&w.config));
        declared.extend(inventory::workflows(&w.config));
        declared.extend(inventory::containers(&w.config).into_keys());
    }
    let mut rows = Vec::new();
    let mut check = |kind: &'static str, names: Vec<&String>| {
        let retired =
            |name: &str| Kind::from_label(kind).is_some_and(|k| spec.retired.matches(k, name));
        for name in names {
            if owned(name) && !declared.contains(name) && !retired(name) {
                rows.push(row(kind, name, Action::Extra, "not in the spec"));
            }
        }
    };
    check("worker", live.workers.keys().collect());
    check("d1", live.d1.keys().collect());
    check("r2", live.r2.iter().collect());
    check("queue", live.queues.keys().collect());
    check("workflow", live.workflows.iter().collect());
    check("container", live.containers.keys().collect());
    rows
}

pub(crate) fn print(env: &Env, rows: &[Row], live: &Live) -> usize {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|r| {
            vec![
                r.kind.into(),
                r.name.clone(),
                r.action.label().into(),
                r.detail.clone(),
            ]
        })
        .collect();
    table(
        &format!("infra plan {}", env.name()),
        &["Kind", "Name", "Action", "Detail"],
        &cells,
    );
    let count = |a: Action| rows.iter().filter(|r| r.action == a).count();
    println!(
        "\n{}: {} create, {} unchanged, {} drift, {} extra, {} orphan, {} unverified",
        env.name(),
        count(Action::Create),
        count(Action::Unchanged),
        count(Action::Drift),
        count(Action::Extra),
        count(Action::Orphan),
        count(Action::Unknown)
    );
    for error in &live.errors {
        println!("Unreadable: {error}");
    }
    count(Action::Drift) + count(Action::Unknown)
}

pub(crate) async fn command(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let lock = Lock::load(&env)?;
    let mut live = super::live::read(&spec, super::live::token(args)?, &spec.worker_names()?).await;
    retired::read_artifacts(&spec, &mut live);
    let workers = inventory::deployables(&spec, &effective_lock(&spec, &lock, &live)?)?;
    let mut rows = diff(&spec, &lock, &workers, &live);
    rows.extend(retired::orphans(
        &spec.retired,
        &retired::protected(&workers)?,
        &live,
    ));
    let unsettled = print(&env, &rows, &live);
    if unsettled > 0 && args.iter().any(|a| a == "--strict") {
        return Err(format!("{unsettled} drifted or unverified item(s)").into());
    }
    Ok(())
}
