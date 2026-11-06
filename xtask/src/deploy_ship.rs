//! Production deploys require a successful release CI run at the merged PR's exact tree.
//! The optional `live-tests` command attests a full local kit; deployment does not read it.
use crate::deploy_evidence::{EVIDENCE_DIR, full_kit_passes, newest_evidence};
use crate::deploy_guard::{self as guard, Facts, Options, short};
use crate::infra::spec::{Env, Spec};
use crate::process::Result;
use serde_json::Value;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

const LIVE_TESTS: &str = "live-tests";
/// Account expected when explicitly publishing the optional local attestation.
const OWNER: &str = "MagnetonIO";
const CI_WORKFLOW: &str = ".github/workflows/ci.yml";

/// What GitHub says about a merged ship PR's head.
#[derive(Clone, Debug, Default)]
pub(crate) struct ShipFacts {
    pub repo: String,
    pub pr_head: String,
    /// The PR head's tree (`None`: not in this clone).
    pub tree: Option<String>,
    /// Release CI pull-request runs at the PR head.
    pub runs: Vec<Value>,
    /// Completed final gates bound to one run and its latest attempt.
    pub gates: Vec<ReleaseGate>,
}

/// Stable release proof after GitHub drops the merged PR from a run's associations.
#[derive(Clone, Debug)]
pub(crate) struct ReleaseGate {
    run_id: u64,
    attempt: u64,
    head: String,
}

fn identity(run: &Value) -> Option<(u64, u64)> {
    Some((
        run["id"].as_u64().filter(|id| *id > 0)?,
        run["run_attempt"].as_u64().filter(|n| *n > 0)?,
    ))
}

/// A complete, unpaginated latest-attempt page must contain exactly one successful final gate.
fn final_gate(run: &Value, page: &Value, paginated: bool) -> Option<ReleaseGate> {
    if paginated {
        return None;
    }
    let (run_id, attempt) = identity(run)?;
    let jobs = page["jobs"].as_array()?;
    let total = page["total_count"].as_u64()?;
    if total == 0 || total > 100 || usize::try_from(total).ok()? != jobs.len() {
        return None;
    }
    let mut gates = jobs.iter().filter(|job| job["name"] == "Ship gate");
    let gate = gates.next()?;
    if gates.next().is_some()
        || gate["status"] != "completed"
        || gate["conclusion"] != "success"
        || gate["run_id"].as_u64() != Some(run_id)
        || gate["run_attempt"].as_u64() != Some(attempt)
        || gate["head_sha"] != run["head_sha"]
    {
        return None;
    }
    Some(ReleaseGate {
        run_id,
        attempt,
        head: gate["head_sha"].as_str()?.into(),
    })
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

/// The PR head has HEAD's tree and this repository's release CI succeeded there.
pub(crate) fn passes(facts: &Facts) -> Result<()> {
    let ship = facts
        .ship
        .as_ref()
        .ok_or("Refusing prod: the release CI proof was not read.")?;
    let head = short(&ship.pr_head);
    if facts.head_tree.is_empty() || ship.tree.as_deref() != Some(facts.head_tree.as_str()) {
        return Err(format!(
            "Refusing prod: PR head {head} has a different tree from HEAD {}.",
            short(&facts.head)
        )
        .into());
    }
    if !ship.runs.iter().any(|run| ship_run(run, ship)) {
        return Err(format!(
            "Refusing prod: no successful release CI run at {head}, so required CI validation did not pass there."
        )
        .into());
    }
    Ok(())
}

/// A successful release CI run of this repository's dev at the PR head. A fork's run counts for
/// nothing: `pull_request` runs of forks live in this repository too.
fn ci_run(run: &Value, ship: &ShipFacts) -> bool {
    let path = run["path"].as_str().unwrap_or_default();
    run["event"] == "pull_request"
        && run["conclusion"] == "success"
        && run["head_sha"] == ship.pr_head.as_str()
        && run["head_branch"] == "dev"
        && run["head_repository"]["full_name"] == ship.repo.as_str()
        && (path == CI_WORKFLOW || path.starts_with(&format!("{CI_WORKFLOW}@")))
}

fn ship_run(run: &Value, ship: &ShipFacts) -> bool {
    ci_run(run, ship)
        && ship.gates.iter().any(|gate| {
            identity(run) == Some((gate.run_id, gate.attempt)) && run["head_sha"] == gate.head
        })
}

/// Reads release CI runs; needs GITHUB_REPOSITORY and GH_TOKEN on a runner or workstation.
pub(crate) async fn gather(pr_head: &str) -> Result<ShipFacts> {
    let variable = |name: &str| {
        std::env::var(name)
            .map_err(|_| format!("--ship-head needs release CI proof: {name} is not set"))
    };
    let (repo, token) = (variable("GITHUB_REPOSITORY")?, variable("GH_TOKEN")?);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("yonedarepo-xtask")
        .build()?;
    let get = async |path: String| -> Result<(Value, bool)> {
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
        let paginated = answer.headers().contains_key(reqwest::header::LINK);
        Ok((answer.json().await?, paginated))
    };
    let (runs, _) = get(format!(
        "actions/workflows/ci.yml/runs?head_sha={pr_head}&event=pull_request&status=success&per_page=20"
    ))
    .await?;
    let list = |value: &Value| value.as_array().cloned().unwrap_or_default();
    let mut ship = ShipFacts {
        pr_head: pr_head.to_owned(),
        tree: guard::tree_of(pr_head),
        runs: list(&runs["workflow_runs"]),
        gates: Vec::new(),
        repo: repo.clone(),
    };
    for run in &ship.runs {
        if !ci_run(run, &ship) {
            continue;
        }
        let Some((id, _)) = identity(run) else {
            continue;
        };
        let (page, paginated) =
            get(format!("actions/runs/{id}/jobs?filter=latest&per_page=100")).await?;
        if let Some(gate) = final_gate(run, &page, paginated) {
            ship.gates.push(gate);
            break;
        }
    }
    Ok(ship)
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
/// evidence is a full pass at HEAD, sets an optional status. HEAD must be on GitHub.
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
