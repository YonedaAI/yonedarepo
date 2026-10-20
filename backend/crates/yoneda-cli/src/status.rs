//! `yoneda status`: the pinned base, the pending local commits and, when the platform is
//! reachable, how far the branch and its projections have moved.
use crate::checkout::Checkout;
use crate::error::Result;
use serde_json::Value;

pub async fn status(co: &Checkout) -> Result<()> {
    let s = &co.state;
    println!("repo    {} at {}", s.repo, s.origin);
    println!(
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
    println!(
        "pending {} local commit(s): {pushed} pushed to {}, {} not yet",
        commits.len(),
        s.offline_branch,
        commits.len() - pushed
    );
    if let Some(landed) = &s.last_land {
        println!(
            "landed  last at version {} (Git commit {})",
            landed.version,
            landed
                .git_commit
                .as_deref()
                .map(short)
                .unwrap_or("not projected yet")
        );
    }
    match co.api.status().await {
        Ok(remote) => print_remote(co, &remote).await,
        Err(f) if f.code == "UNREACHABLE" => println!("remote  unreachable: working offline"),
        Err(f) => println!("remote  {f}"),
    }
    Ok(())
}

async fn print_remote(co: &Checkout, remote: &Value) {
    let s = &co.state;
    let version = remote["version"].as_u64().unwrap_or_default();
    println!(
        "remote  log version {version}: {} version(s) after your base",
        version.saturating_sub(s.base_version)
    );
    let refname = format!("refs/heads/{}", s.branch);
    let row = remote["refs"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["name"] == refname.as_str());
    // The refs table holds the branch's Git commit as of its last projected version;
    // changesets landed after it still await their Git commit.
    if let Some(projected) = row.and_then(|r| r["version"].as_u64()) {
        println!(
            "lag     {} Git commit as of version {projected}; {}",
            s.branch,
            awaiting(co, projected).await
        );
    }
    let store = remote["projections"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["refname"] == refname.as_str());
    if let Some(p) = store {
        let target = p["target_version"].as_u64().unwrap_or_default();
        let stored = p["projected_version"].as_u64().unwrap_or_default();
        println!(
            "store   object store at version {stored} of {target} ({})",
            p["status"].as_str().unwrap_or("unknown")
        );
    }
}

/// How many changesets landed on the branch after `projected` have no Git commit yet.
async fn awaiting(co: &Checkout, projected: u64) -> String {
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
            format!("{waiting} landed changeset(s) await their Git commit{more}")
        }
        Err(f) => format!("changeset projection unknown ({f})"),
    }
}

fn short(id: &str) -> &str {
    id.get(..12).unwrap_or(id)
}
