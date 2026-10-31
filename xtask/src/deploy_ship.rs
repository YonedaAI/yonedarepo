//! The GitHub side of a ship (docs/ship-pipeline.md). Live tests stay on the owner's Mac:
//! `cargo xtask live-tests` turns a passing full kit into a `live-tests` commit status, and a
//! prod deploy from a merged ship PR (`--ship-head`) reads that status and the PR head's Ship
//! run instead of the dev Workers and the evidence file. This repository is public, so the
//! status says only "pass" and the tree. Decisions are pure over gathered facts, as in
//! deploy_guard. Local deploys never come through here.
use crate::deploy_evidence::{EVIDENCE_DIR, full_kit_passes, newest_evidence};
use crate::deploy_guard::{self as guard, Facts, Options, short};
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use serde_json::Value;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

const LIVE_TESTS: &str = "live-tests";
/// Only the owner's status counts: a workflow token with `statuses: write` is someone else.
const OWNER: &str = "MagnetonIO";
const SHIP_WORKFLOW: &str = ".github/workflows/ship.yml";

/// What GitHub says about a merged ship PR's head.
#[derive(Clone, Debug, Default)]
pub(crate) struct ShipFacts {
    pub repo: String,
    pub pr_head: String,
    /// The PR head's tree (`None`: not in this clone).
    pub tree: Option<String>,
    /// The commit's statuses, newest first, as GitHub lists them.
    pub statuses: Vec<Value>,
    /// Ship workflow runs at the PR head.
    pub runs: Vec<Value>,
}

/// `--ship-head <sha>`.
pub(crate) fn head_arg(args: &[String]) -> Result<Option<String>> {
    let Some(at) = args.iter().position(|a| a == "--ship-head") else {
        return Ok(None);
    };
    match args.get(at + 1) {
        Some(sha) if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()) => {
            Ok(Some(sha.clone()))
        }
        _ => Err("--ship-head needs the merged PR head's full commit id".into()),
    }
}

fn description(tree: &str) -> String {
    format!("pass tree {tree}")
}

/// The PR head has HEAD's tree, its newest `live-tests` is the owner's pass for that tree, and a
/// Ship run of this repository's dev (Check and Full suite are its jobs) succeeded there.
pub(crate) fn passes(facts: &Facts) -> Result<()> {
    let ship = facts
        .ship
        .as_ref()
        .ok_or("Refusing prod: the ship statuses were not read.")?;
    let head = short(&ship.pr_head);
    if facts.head_tree.is_empty() || ship.tree.as_deref() != Some(facts.head_tree.as_str()) {
        return Err(format!(
            "Refusing prod: PR head {head} has a different tree from HEAD {}.",
            short(&facts.head)
        )
        .into());
    }
    live_tests_pass(ship, &facts.head_tree)?;
    if !ship.runs.iter().any(|run| ship_run(run, ship)) {
        return Err(format!(
            "Refusing prod: no successful Ship run at {head}, so Check and Full suite did not pass there."
        )
        .into());
    }
    Ok(())
}

fn live_tests_pass(ship: &ShipFacts, tree: &str) -> Result<()> {
    let head = short(&ship.pr_head);
    let status = ship
        .statuses
        .iter()
        .find(|status| status["context"] == LIVE_TESTS)
        .ok_or_else(|| {
            format!(
                "Refusing prod: no {LIVE_TESTS} status at {head}. Run `cargo xtask live-tests`."
            )
        })?;
    if status["state"] != "success" {
        let state = status["state"].as_str().unwrap_or("missing");
        return Err(format!("Refusing prod: {LIVE_TESTS} is {state} at {head}.").into());
    }
    if status["creator"]["login"] != OWNER {
        return Err(
            format!("Refusing prod: {LIVE_TESTS} at {head} was not set by {OWNER}.").into(),
        );
    }
    if status["description"] != description(tree).as_str() {
        return Err(format!("Refusing prod: {LIVE_TESTS} at {head} is for another tree.").into());
    }
    Ok(())
}

/// A successful Ship run of this repository's dev at the PR head. A fork's run counts for
/// nothing: `pull_request` runs of forks live in this repository too.
fn ship_run(run: &Value, ship: &ShipFacts) -> bool {
    let path = run["path"].as_str().unwrap_or_default();
    run["event"] == "pull_request"
        && run["conclusion"] == "success"
        && run["head_sha"] == ship.pr_head.as_str()
        && run["head_branch"] == "dev"
        && run["head_repository"]["full_name"] == ship.repo.as_str()
        && (path == SHIP_WORKFLOW || path.starts_with(&format!("{SHIP_WORKFLOW}@")))
}

/// Reads the PR head's statuses and Ship runs; needs the runner's GITHUB_REPOSITORY and GH_TOKEN.
pub(crate) async fn gather(pr_head: &str) -> Result<ShipFacts> {
    let variable = |name: &str| {
        std::env::var(name)
            .map_err(|_| format!("--ship-head runs in GitHub Actions: {name} is not set"))
    };
    let (repo, token) = (variable("GITHUB_REPOSITORY")?, variable("GH_TOKEN")?);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("yonedarepo-xtask")
        .build()?;
    let get = async |path: String| -> Result<Value> {
        let answer = client
            .get(format!("https://api.github.com/repos/{repo}/{path}"))
            .bearer_auth(&token)
            .header("accept", "application/vnd.github+json")
            .send()
            .await?;
        let status = answer.status();
        if !status.is_success() {
            return Err(format!("GitHub answered {status} for {path}").into());
        }
        Ok(answer.json().await?)
    };
    let statuses = get(format!("commits/{pr_head}/statuses?per_page=100")).await?;
    let runs = get(format!(
        "actions/workflows/ship.yml/runs?head_sha={pr_head}&event=pull_request&status=success&per_page=20"
    ))
    .await?;
    let list = |value: &Value| value.as_array().cloned().unwrap_or_default();
    Ok(ShipFacts {
        pr_head: pr_head.to_owned(),
        tree: guard::tree_of(pr_head),
        statuses: list(&statuses),
        runs: list(&runs["workflow_runs"]),
        repo,
    })
}

fn status_args(sha: &str, tree: &str) -> Vec<String> {
    [
        "api".to_owned(),
        "--method".to_owned(),
        "POST".to_owned(),
        "--silent".to_owned(),
        format!("repos/{{owner}}/{{repo}}/statuses/{sha}"),
        "-f".to_owned(),
        "state=success".to_owned(),
        "-f".to_owned(),
        format!("context={LIVE_TESTS}"),
        "-f".to_owned(),
        format!("description={}", description(tree)),
    ]
    .into()
}

/// `cargo xtask live-tests [--dry-run]`: on a clean checkout at the tip of dev whose newest kit
/// evidence is a full pass at HEAD, sets the status a ship needs. HEAD must be on GitHub.
pub(crate) fn mark(args: &[String]) -> Result<()> {
    let spec = Spec::load(&Env::Dev)?;
    let mut facts = guard::git_facts(&spec)?;
    guard::preflight(&Env::Dev, &spec, &facts, &Options::default())?;
    facts.evidence = newest_evidence(Path::new(EVIDENCE_DIR))?;
    full_kit_passes(&facts)?;
    let call = status_args(&facts.head, &facts.head_tree);
    if args.iter().any(|a| a == "--dry-run") {
        println!("gh {}", call.join(" "));
        return Ok(());
    }
    let status = Command::new("gh")
        .args(&call)
        .stdout(Stdio::null())
        .status()
        .map_err(|error| format!("Cannot start gh: {error}"))?;
    if !status.success() {
        return Err(format!(
            "Setting {LIVE_TESTS} failed: is {} pushed, and is gh signed in as {OWNER}?",
            short(&facts.head)
        )
        .into());
    }
    println!("{LIVE_TESTS}: pass at {}", short(&facts.head));
    Ok(())
}

#[cfg(test)]
#[path = "deploy_ship/tests.rs"]
mod tests;
