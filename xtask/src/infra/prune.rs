//! `infra prune --env <env> --confirm [--dry-run] [--allow-active]`: deletes exactly the
//! `orphan` rows of `infra plan` (live resources under the spec's `retired` names), after
//! checking each one against every committed spec. Busy containers stop it, as a rollout would.
use super::apply::snapshot;
use super::live::Live;
use super::plan::{self, Action, Row};
use super::retired::{self, Kind};
use super::spec::{Env, Lock, Spec};
use super::{inventory, wrangler};
use crate::deploy_guard::{self as guard, Options};
use crate::process::Result;
use std::collections::BTreeSet;

/// Checks before anything is deleted: no unreadable section, no retired name a spec still
/// binds, and every row still an orphan against the protected set.
pub(crate) fn refusal(
    rows: &[Row],
    protected: &BTreeSet<(Kind, String)>,
    live: &Live,
) -> Option<String> {
    if !live.errors.is_empty() {
        return Some(format!(
            "Refusing to prune: cannot read live state ({}).",
            live.errors.join("; ")
        ));
    }
    if let Some(row) = rows.iter().find(|r| r.action != Action::Orphan) {
        return Some(format!(
            "Refusing to prune: {} {} is retired but a current spec binds it.",
            row.kind, row.name
        ));
    }
    let bound = rows.iter().find(|r| {
        Kind::from_label(r.kind).is_none_or(|k| protected.contains(&(k, r.name.clone())))
    })?;
    Some(format!(
        "Refusing to prune: {} {} is bound by a current spec.",
        bound.kind, bound.name
    ))
}

/// The wrangler deletions for the rows, in an order the API accepts: queue consumers, then
/// Workers (their Durable Objects go with them), container apps, workflows, Artifacts
/// repositories, queues (dead-letter queues last), D1 and R2.
pub(crate) fn deletions(rows: &[Row], live: &Live) -> Vec<(String, Vec<String>)> {
    let of = |kind: Kind| -> Vec<&String> {
        rows.iter()
            .filter(|r| r.kind == kind.label())
            .map(|r| &r.name)
            .collect()
    };
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut push = |label: String, args: &[&str]| {
        out.push((label, args.iter().map(|a| (*a).to_owned()).collect()));
    };
    let workers = of(Kind::Worker);
    for worker in &workers {
        for (queue, scripts) in &live.queues {
            if scripts.contains(*worker) {
                push(
                    format!("Consumer {queue} of {worker}"),
                    &["queues", "consumer", "remove", queue, worker],
                );
            }
        }
    }
    for worker in &workers {
        push(format!("Worker {worker}"), &["delete", worker, "--force"]);
    }
    for app in of(Kind::Container) {
        if let Some(id) = live.containers.get(app).and_then(|a| a["id"].as_str()) {
            push(format!("Container {app}"), &["containers", "delete", id]);
        }
    }
    for name in of(Kind::Workflow) {
        push(format!("Workflow {name}"), &["workflows", "delete", name]);
    }
    for namespace in of(Kind::Artifacts) {
        for repo in live.artifacts.get(namespace).into_iter().flatten() {
            push(
                format!("Artifacts {namespace}/{repo}"),
                &[
                    "artifacts",
                    "repos",
                    "delete",
                    repo,
                    "--namespace",
                    namespace,
                    "--force",
                ],
            );
        }
    }
    let (dead, others): (Vec<&String>, Vec<&String>) = of(Kind::Queue)
        .into_iter()
        .partition(|q| q.contains("dead-letter"));
    for queue in others.into_iter().chain(dead) {
        push(format!("Queue {queue}"), &["queues", "delete", queue]);
    }
    for name in of(Kind::D1) {
        push(
            format!("D1 {name}"),
            &["d1", "delete", name, "--skip-confirmation"],
        );
    }
    for name in of(Kind::R2) {
        push(
            format!("R2 {name} (must be empty)"),
            &["r2", "bucket", "delete", name],
        );
    }
    out
}

async fn orphan_rows(
    spec: &Spec,
    env: &Env,
    token: &str,
) -> Result<(Vec<Row>, Live, BTreeSet<(Kind, String)>)> {
    let mut live = snapshot(spec, token).await?;
    retired::read_artifacts(spec, &mut live);
    let lock = plan::effective_lock(spec, &Lock::load(env)?, &live)?;
    let protected = retired::protected(&inventory::deployables(spec, &lock)?)?;
    let rows = retired::orphans(&spec.retired, &protected, &live);
    Ok((rows, live, protected))
}

pub(crate) async fn command(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let options = Options::from_args(args)?;
    if !options.confirm && !options.dry_run {
        return Err(format!(
            "Refusing to prune {} without --confirm (or --dry-run).",
            env.name()
        )
        .into());
    }
    let spec = Spec::load(&env)?;
    if spec.retired.is_empty() {
        println!("{} lists no retired names; nothing to prune.", env.name());
        return Ok(());
    }
    let token = super::live::token(args)?;
    let (rows, live, protected) = orphan_rows(&spec, &env, &token).await?;
    plan::print(&env, &rows, &live);
    if let Some(reason) = refusal(&rows, &protected, &live) {
        return Err(reason.into());
    }
    let steps = deletions(&rows, &live);
    if options.dry_run || steps.is_empty() {
        for (label, args) in &steps {
            println!("Dry run: would delete {label}: wrangler {}", args.join(" "));
        }
        return Ok(());
    }
    let apps: BTreeSet<String> = rows
        .iter()
        .filter(|r| r.kind == Kind::Container.label())
        .map(|r| r.name.clone())
        .collect();
    if !apps.is_empty() {
        let busy = crate::deploy_live::busy_apps(&spec.account_id, |name| apps.contains(name))?;
        let active = busy.iter().map(|(_, n)| n).sum();
        guard::busy_gate("deleting the retired container apps", active, &options)?;
    }
    let mut failures = Vec::new();
    for (label, args) in &steps {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        if let Err(error) = wrangler::run(&spec.account_id, &args) {
            failures.push(format!("{label}: {error}"));
        }
    }
    let (after, live, _) = orphan_rows(&spec, &env, &token).await?;
    plan::print(&env, &after, &live);
    if !failures.is_empty() {
        return Err(format!(
            "{} prune step(s) failed (rerun after fixing; an R2 bucket must be emptied first):\n{}",
            failures.len(),
            failures.join("\n")
        )
        .into());
    }
    Ok(())
}
