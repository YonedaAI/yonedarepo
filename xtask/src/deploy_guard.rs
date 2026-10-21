//! Deploy guards. Decisions are pure functions over gathered facts, so every refusal is
//! unit-tested without Git state or network access.
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use serde_json::Value;
use std::path::Path;
use std::process::Command;

/// Real-world kit evidence, newest first: `.local/staging/realworld*.json`.
pub(crate) const EVIDENCE_DIR: &str = ".local/staging";

#[derive(Clone, Debug, Default)]
pub(crate) struct Options {
    pub dry_run: bool,
    pub confirm: bool,
    pub allow_active: bool,
}

impl Options {
    pub(crate) fn from_args(args: &[String]) -> Self {
        let flag = |name: &str| args.iter().any(|a| a == name);
        Self {
            dry_run: flag("--dry-run"),
            confirm: flag("--confirm"),
            allow_active: flag("--allow-active"),
        }
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

/// The kit must have run against this exact commit and passed every item.
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

/// Prod only: a container rollout restarts instances and kills their runs.
pub(crate) fn active_gate(env: &Env, worker: &str, active: u64, options: &Options) -> Result<()> {
    if active == 0 || !env.is_prod() || options.allow_active {
        return Ok(());
    }
    Err(format!(
        "Stopping before {worker}: {active} container instance(s) are busy and a rollout kills their runs. Retry when idle, or pass --allow-active."
    )
    .into())
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
