//! Deploy guards. Decisions are pure functions over gathered facts, so every refusal is
//! unit-tested without Git state or network access.
use crate::infra::spec::{Env, Lock, PENDING_D1, Spec};
use crate::process::Result;
use serde_json::Value;
use std::collections::BTreeMap;
use std::process::Command;

#[derive(Clone, Debug, Default)]
pub(crate) struct Options {
    pub dry_run: bool,
    pub confirm: bool,
    pub allow_active: bool,
    /// Dev only: the front Worker alone, for a change that touches nothing else.
    pub front_only: bool,
    /// `--prebuilt <dir>`: deploy CI's tested outputs instead of building (deploy_prebuilt).
    pub prebuilt: Option<std::path::PathBuf>,
    /// `--ship-head <sha>`: the merged ship PR's head, on a runner (deploy_ship).
    pub ship_head: Option<String>,
}

impl Options {
    pub(crate) fn from_args(args: &[String]) -> Result<Self> {
        let flag = |name: &str| args.iter().any(|a| a == name);
        Ok(Self {
            dry_run: flag("--dry-run"),
            confirm: flag("--confirm"),
            allow_active: flag("--allow-active"),
            front_only: flag("--front"),
            prebuilt: crate::deploy_prebuilt::dir_arg(args)?,
            ship_head: crate::deploy_ship::head_arg(args)?,
        })
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Facts {
    pub head: String,
    /// `HEAD^{tree}`. A commit with this tree is the same code: a PR merge makes a new commit
    /// from the tree its head was tested at.
    pub head_tree: String,
    /// The tree of each commit the dev Workers and the kit evidence name, when this clone has it.
    pub trees: BTreeMap<String, String>,
    /// `git status --porcelain` lines; empty means a clean tree.
    pub dirty: Vec<String>,
    /// Tips of the spec's branch (local and origin) when the spec names one.
    pub ref_tips: Vec<String>,
    /// Prod only: each dev Worker's live `/health` revision (`None` when unreachable).
    pub dev_revisions: Vec<(String, Option<String>)>,
    /// Prod only: the newest real-world kit evidence.
    pub evidence: Option<Value>,
    /// With `--ship-head`: the PR head's GitHub statuses, read instead of the two above.
    pub ship: Option<crate::deploy_ship::ShipFacts>,
}

impl Facts {
    /// The commit is HEAD, or another commit of HEAD's tree (an ungathered tree matches nothing).
    pub(crate) fn same_code(&self, commit: &str) -> bool {
        commit == self.head
            || (!self.head_tree.is_empty() && self.trees.get(commit) == Some(&self.head_tree))
    }
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
        return match options.ship_head {
            Some(_) => Err("--ship-head is for a prod deploy.".into()),
            None => Ok(()),
        };
    }
    if !options.confirm {
        return Err("Refusing to deploy prod without --confirm.".into());
    }
    if options.ship_head.is_some() {
        return crate::deploy_ship::passes(facts);
    }
    if facts.dev_revisions.is_empty() {
        return Err("Refusing prod: no dev Worker reports a /health revision.".into());
    }
    for (worker, revision) in &facts.dev_revisions {
        if !revision.as_deref().is_some_and(|r| facts.same_code(r)) {
            return Err(format!(
                "Refusing prod: dev {worker} runs {}, not HEAD {} or a commit of its tree. Run `cargo xtask deploy --env dev` first.",
                revision.as_deref().unwrap_or("nothing reachable"),
                short(&facts.head)
            )
            .into());
        }
    }
    crate::deploy_evidence::evidence_passes(facts.evidence.as_ref(), facts)
}

/// A D1 database the lock marks `pending` does not exist yet; deploying would bind nothing.
pub(crate) fn refuse_pending(env: &Env, lock: &Lock) -> Result<()> {
    match lock.d1.iter().find(|(_, id)| id.as_str() == PENDING_D1) {
        Some((name, _)) => Err(format!(
            "D1 {name} is not created yet (lock says {PENDING_D1}): run `cargo xtask infra prepare --env {} --confirm`, then review and commit its identities first.",
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

/// The commit's tree, when this clone has the commit (full object ids only: the argument can
/// come from a Worker's `/health` or an evidence file).
pub(crate) fn tree_of(commit: &str) -> Option<String> {
    let full = commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit());
    full.then(|| git(&["rev-parse", "--verify", "-q", &format!("{commit}^{{tree}}")]).ok())?
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
        head_tree: git(&["rev-parse", "HEAD^{tree}"])?,
        dirty: git(&["status", "--porcelain"])?
            .lines()
            .map(str::to_owned)
            .collect(),
        ref_tips: tips,
        ..Facts::default()
    })
}
