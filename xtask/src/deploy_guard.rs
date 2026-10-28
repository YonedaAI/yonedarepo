//! Deploy guards. Decisions are pure functions over gathered facts, so every refusal is
//! unit-tested without Git state or network access.
use crate::infra::spec::{Env, Lock, PENDING_D1, Spec};
use crate::process::Result;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

/// Real-world kit evidence, newest first: `.local/staging/realworld*.json`.
pub(crate) const EVIDENCE_DIR: &str = ".local/staging";

#[derive(Clone, Debug, Default)]
pub(crate) struct Options {
    pub dry_run: bool,
    pub confirm: bool,
    pub allow_active: bool,
    /// `--prebuilt <dir>`: deploy CI's tested outputs instead of building (deploy_prebuilt).
    pub prebuilt: Option<std::path::PathBuf>,
}

impl Options {
    pub(crate) fn from_args(args: &[String]) -> Result<Self> {
        let flag = |name: &str| args.iter().any(|a| a == name);
        Ok(Self {
            dry_run: flag("--dry-run"),
            confirm: flag("--confirm"),
            allow_active: flag("--allow-active"),
            prebuilt: crate::deploy_prebuilt::dir_arg(args)?,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Facts {
    pub head: String,
    /// `git status --porcelain` lines; empty means a clean tree.
    pub dirty: Vec<String>,
    /// Tips of the spec's branch (local and origin) when the spec names one.
    pub ref_tips: Vec<String>,
    /// Prod only: each dev Worker's live `/health` revision (`None` when unreachable).
    pub dev_revisions: Vec<(String, Option<String>)>,
    /// Prod only: the newest real-world kit evidence.
    pub evidence: Option<Value>,
}

/// Everything checked before the first build step.
pub(crate) fn preflight(env: &Env, spec: &Spec, facts: &Facts, options: &Options) -> Result<()> {
    if !facts.dirty.is_empty() {
        let shown: Vec<&str> = facts.dirty.iter().take(5).map(String::as_str).collect();
        return Err(format!(
            "Refusing to deploy: the working tree has uncommitted changes ({}). Commit or stash them first.",
            shown.join(", ")
        )
        .into());
    }
    if let Some(branch) = &spec.git_ref
        && !facts.ref_tips.contains(&facts.head)
    {
        return Err(format!(
            "Refusing to deploy {}: HEAD {} is not the tip of {branch} (local or origin).",
            env.name(),
            short(&facts.head)
        )
        .into());
    }
    if !env.is_prod() {
        return Ok(());
    }
    if !options.confirm {
        return Err("Refusing to deploy prod without --confirm.".into());
    }
    if facts.dev_revisions.is_empty() {
        return Err("Refusing prod: no dev Worker reports a /health revision.".into());
    }
    for (worker, revision) in &facts.dev_revisions {
        if revision.as_deref() != Some(facts.head.as_str()) {
            return Err(format!(
                "Refusing prod: dev {worker} runs {}, not HEAD {}. Run `cargo xtask deploy --env dev` first.",
                revision.as_deref().unwrap_or("nothing reachable"),
                short(&facts.head)
            )
            .into());
        }
    }
    evidence_passes(facts.evidence.as_ref(), &facts.head)
}

/// The kit's browser gate (tools/staging/browser-flow.mjs). Like every item in the evidence, it
/// must pass when present; while the kit can still run without it, its absence is allowed.
/// Set to true once every kit run records it.
pub(crate) const BROWSER_ITEM: &str = "browser";
pub(crate) const BROWSER_REQUIRED: bool = false;

/// The kit must have run against this exact commit and passed every item it lists: item 0
/// (live revisions) always, the browser item whenever it is present.
pub(crate) fn evidence_passes(evidence: Option<&Value>, head: &str) -> Result<()> {
    let evidence = evidence.ok_or(
        "Refusing prod: no real-world kit evidence in .local/staging/. Run `node tools/staging-realworld.mjs` against dev.",
    )?;
    let items = evidence["items"]
        .as_array()
        .filter(|items| !items.is_empty())
        .ok_or("Refusing prod: kit evidence lists no items.")?;
    let revisions = items.iter().find(|item| item["id"] == "0").map(|item| {
        (
            item["metrics"]["front"].as_str(),
            item["metrics"]["platform"].as_str(),
        )
    });
    if revisions != Some((Some(head), Some(head))) {
        return Err(format!(
            "Refusing prod: the newest kit evidence was not recorded against HEAD {} (item 0 revisions: {revisions:?}).",
            short(head)
        )
        .into());
    }
    if BROWSER_REQUIRED && !items.iter().any(|item| item["id"] == BROWSER_ITEM) {
        return Err(format!(
            "Refusing prod: the newest kit evidence has no {BROWSER_ITEM} item. Run the kit with --browser."
        )
        .into());
    }
    if let Some(item) = items.iter().find(|item| item["status"] != "pass") {
        return Err(format!(
            "Refusing prod: kit item {} ({}) is {}, not pass.",
            item["id"].as_str().unwrap_or("?"),
            item["title"].as_str().unwrap_or(""),
            item["status"].as_str().unwrap_or("missing")
        )
        .into());
    }
    Ok(())
}

/// A D1 database the lock marks `pending` does not exist yet; deploying would bind nothing.
pub(crate) fn refuse_pending(env: &Env, lock: &Lock) -> Result<()> {
    match lock.d1.iter().find(|(_, id)| id.as_str() == PENDING_D1) {
        Some((name, _)) => Err(format!(
            "D1 {name} is not created yet (lock says {PENDING_D1}): run `cargo xtask infra up --env {}` first.",
            env.name()
        )
        .into()),
        None => Ok(()),
    }
}

/// Prod only: a container rollout restarts instances and kills their runs.
pub(crate) fn active_gate(env: &Env, worker: &str, active: u64, options: &Options) -> Result<()> {
    if !env.is_prod() {
        return Ok(());
    }
    busy_gate(worker, active, options)
}

/// Busy (active or assigned) container instances stop whatever comes next (a rollout, a cutover, a deletion),
/// unless `--allow-active`.
pub(crate) fn busy_gate(what: &str, active: u64, options: &Options) -> Result<()> {
    if active == 0 || options.allow_active {
        return Ok(());
    }
    Err(format!(
        "Stopping before {what}: {active} container instance(s) are active (not just starting) and this kills their runs. Retry when idle, or pass --allow-active."
    )
    .into())
}

/// The busy instances the gates count: always-on container apps (`always_on` in the env
/// spec: they run without work, so a rollout kills no runs) are left out, each running one
/// with a note of what the rollout drops.
pub(crate) fn counted(
    busy: Vec<(String, u64)>,
    always_on: &BTreeMap<String, String>,
) -> (Vec<(String, u64)>, Vec<String>) {
    let (on, counted): (Vec<_>, Vec<_>) = busy
        .into_iter()
        .partition(|(app, _)| always_on.contains_key(app));
    let notes = on
        .iter()
        .filter(|(_, count)| *count > 0)
        .map(|(app, _)| {
            format!(
                "Note: {app} is always on (not counted as busy); {} drop during the rollout.",
                always_on[app]
            )
        })
        .collect();
    (counted, notes)
}

/// A workstation deploy of dev that changes a container app's image restarts its instances
/// and kills the runs on them: stop unless none is busy or `--allow-active` is given. A dry
/// run only reports.
pub(crate) fn rollout_gate(busy: &[(String, u64)], options: &Options) -> Result<()> {
    let busy: Vec<String> = busy
        .iter()
        .filter(|(_, count)| *count > 0)
        .map(|(app, count)| format!("{app}: {count}"))
        .collect();
    if busy.is_empty() {
        println!("Rollout gate: no busy container instance.");
        return Ok(());
    }
    let list = busy.join(", ");
    if options.dry_run || options.allow_active {
        println!(
            "WARNING: the container rollout will stop running checks ({list} active instance(s))."
        );
        return Ok(());
    }
    Err(format!(
        "Stopping before the container rollout: active instances ({list}) would be killed (starting ones are not counted). Retry when idle, or pass --allow-active."
    )
    .into())
}

/// CI's dev deploy after a push: skip it when every Worker with `/health` already runs the
/// commit (deployed from the owner's Mac); otherwise deploy, saying why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LiveCheck {
    Skip(String),
    Deploy(String),
}

pub(crate) fn live_check(head: &str, revisions: &[(String, Option<String>)]) -> LiveCheck {
    if revisions.is_empty() {
        return LiveCheck::Deploy("no Worker reports a /health revision".into());
    }
    let behind: Vec<String> = revisions
        .iter()
        .filter(|(_, live)| live.as_deref() != Some(head))
        .map(|(worker, live)| {
            format!(
                "{worker} runs {}",
                live.as_deref().map_or("nothing reachable", short)
            )
        })
        .collect();
    if behind.is_empty() {
        let workers: Vec<&str> = revisions.iter().map(|(w, _)| w.as_str()).collect();
        LiveCheck::Skip(format!(
            "Deploy skipped: {} already run {} (deployed before this run).",
            workers.join(" and "),
            short(head)
        ))
    } else {
        LiveCheck::Deploy(format!("Deploying {}: {}.", short(head), behind.join("; ")))
    }
}

pub(crate) fn revision_gate(worker: &str, head: &str, live: Option<&str>) -> Result<()> {
    if live == Some(head) {
        return Ok(());
    }
    Err(format!(
        "Stopping: {worker} /health reports {}, expected HEAD {}. Later Workers were not deployed; `cargo xtask rollback` reverts the deployed ones.",
        live.unwrap_or("no revision"),
        short(head)
    )
    .into())
}

pub(crate) fn short(sha: &str) -> &str {
    sha.get(..12).unwrap_or(sha)
}

fn git(args: &[&str]) -> Result<String> {
    let out = Command::new("git").args(args).output()?;
    if !out.status.success() {
        return Err(format!("git {} failed", args.join(" ")).into());
    }
    Ok(String::from_utf8(out.stdout)?.trim().to_owned())
}

pub(crate) fn head() -> Result<String> {
    git(&["rev-parse", "HEAD"])
}

/// Git facts for `preflight`; the prod-only facts are filled in by the caller.
pub(crate) fn git_facts(spec: &Spec) -> Result<Facts> {
    let mut tips = Vec::new();
    if let Some(branch) = &spec.git_ref {
        for name in [
            format!("refs/heads/{branch}"),
            format!("refs/remotes/origin/{branch}"),
        ] {
            if let Ok(tip) = git(&["rev-parse", "--verify", "-q", &name]) {
                tips.push(tip);
            }
        }
    }
    Ok(Facts {
        head: head()?,
        dirty: git(&["status", "--porcelain"])?
            .lines()
            .map(str::to_owned)
            .collect(),
        ref_tips: tips,
        ..Facts::default()
    })
}

/// The most recently modified `realworld*.json` evidence file, parsed.
pub(crate) fn newest_evidence(dir: &Path) -> Result<Option<Value>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(None);
    };
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !(name.starts_with("realworld") && name.ends_with(".json")) {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
            newest = Some((modified, entry.path()));
        }
    }
    match newest {
        Some((_, path)) => Ok(Some(
            serde_json::from_slice(&std::fs::read(&path)?)
                .map_err(|error| format!("Invalid kit evidence {}: {error}", path.display()))?,
        )),
        None => Ok(None),
    }
}
