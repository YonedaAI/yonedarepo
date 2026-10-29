//! `yoneda status`: the pinned base, the pending local commits and, when the platform is
//! reachable, how far the branch and its projections have moved.
use crate::checkout::Checkout;
use crate::error::Result;
use crate::human;
use crate::output::{self, LastLand, Projection, RemoteStatus, Status};
use serde_json::Value;

/// `status --brief` of an offline checkout: its pinned base only.
pub fn brief(co: &Checkout) -> Status {
    let s = &co.state;
    Status::Checkout {
        repo: s.repo.clone(),
        origin: s.origin.clone(),
        branch: s.branch.clone(),
        base_version: s.base_version,
        base_commit: s.base_commit.clone(),
        offline_branch: s.offline_branch.clone(),
        pending: None,
        pushed: None,
        last_land: None,
        remote: None,
    }
}

pub async fn status(co: &Checkout) -> Result<()> {
    let s = &co.state;
    human!("repo    {} at {}", s.repo, s.origin);
    human!(
        "base    {} version {} (platform {})",
        s.branch,
        s.base_version,
        short(&s.base_commit)
    );
    let commits = co.git.first_parent_since(&s.local_base)?;
    let pushed = commits
        .iter()
        .filter(|c| s.platform.contains_key(*c))
        .count();
    human!(
        "pending {} local commit(s): {pushed} pushed to {}, {} not yet",
        commits.len(),
        s.offline_branch,
        commits.len() - pushed
    );
    if let Some(landed) = &s.last_land {
        human!(
            "landed  last at version {} (Git commit {})",
            landed.version,
            landed
                .git_commit
                .as_deref()
                .map(short)
                .unwrap_or("not projected yet")
        );
    }
    let remote = match co.api.status().await {
        Ok(remote) => print_remote(co, &remote).await,
        Err(f) if f.code == "UNREACHABLE" => {
            human!("remote  unreachable: working offline");
            failed("unreachable".into())
        }
        Err(f) => {
            human!("remote  {f}");
            failed(f.to_string())
        }
    };
    let mut report = brief(co);
    if let Status::Checkout {
        pending: p,
        pushed: q,
        last_land,
        remote: r,
        ..
    } = &mut report
    {
        *p = Some(commits.len() as u64);
        *q = Some(pushed as u64);
        *last_land = s.last_land.as_ref().map(|l| LastLand {
            version: l.version,
            git_commit: l.git_commit.clone(),
        });
        *r = Some(Box::new(remote));
    }
    output::emit(&report);
    Ok(())
}

fn failed(error: String) -> RemoteStatus {
    RemoteStatus {
        error: Some(error),
        ..RemoteStatus::default()
    }
}

async fn print_remote(co: &Checkout, remote: &Value) -> RemoteStatus {
    let s = &co.state;
    let version = remote["version"].as_u64().unwrap_or_default();
    human!(
        "remote  log version {version}: {} version(s) after your base",
        version.saturating_sub(s.base_version)
    );
    let mut report = RemoteStatus {
        version: Some(version),
        behind: Some(version.saturating_sub(s.base_version)),
        ..RemoteStatus::default()
    };
    let refname = format!("refs/heads/{}", s.branch);
    let row = remote["refs"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["name"] == refname.as_str());
    // The refs table holds the branch's Git commit as of its last projected version;
    // changesets landed after it still await their Git commit.
    if let Some(projected) = row.and_then(|r| r["version"].as_u64()) {
        let (waiting, text) = awaiting(co, projected).await;
        human!(
            "lag     {} Git commit as of version {projected}; {text}",
            s.branch
        );
        report.projected_version = Some(projected);
        report.awaiting_git_commit = waiting;
    }
    let store = remote["projections"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["refname"] == refname.as_str());
    if let Some(p) = store {
        let target = p["target_version"].as_u64().unwrap_or_default();
        let stored = p["projected_version"].as_u64().unwrap_or_default();
        let status = p["status"].as_str().unwrap_or("unknown");
        human!("store   object store at version {stored} of {target} ({status})");
        report.store = Some(Projection {
            projected_version: stored,
            target_version: target,
            status: status.to_owned(),
        });
    }
    report
}

/// How many changesets landed on the branch after `projected` have no Git commit yet
/// (`None`: unknown), and the sentence saying so.
async fn awaiting(co: &Checkout, projected: u64) -> (Option<u64>, String) {
    let refname = format!("refs/heads/{}", co.state.branch);
    match co
        .api
        .get(&format!("/txlog?after={projected}&limit=500"))
        .await
    {
        Ok(log) => {
            let entries = log["entries"].as_array().cloned().unwrap_or_default();
            let waiting = entries
                .iter()
                .filter(|e| e["kind"] == "changeset" && e["refname"] == refname.as_str())
                .filter(|e| e["projected"]["commit"].is_null())
                .count();
            let more = if entries.len() == 500 {
                " (first 500 versions)"
            } else {
                ""
            };
            (
                Some(waiting as u64),
                format!("{waiting} landed changeset(s) await their Git commit{more}"),
            )
        }
        Err(f) => (None, format!("changeset projection unknown ({f})")),
    }
}

fn short(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}
