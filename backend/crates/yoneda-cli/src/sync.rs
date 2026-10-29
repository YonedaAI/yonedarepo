//! `yoneda sync`: pushes pending local commits as platform commits on this checkout's
//! offline branch (oldest first, each pinned to the base version), then optionally lands
//! the series. A rerun after a crash or lost acknowledgment adopts what already arrived.
use crate::api::{CommitInfo, Failure};
use crate::checkout::Checkout;
use crate::chunk;
use crate::conflict;
use crate::error::{Error, Result};
use crate::human;
use crate::output::SyncLanding;
use crate::plan::{self, Step};
use crate::reconcile;
use crate::snapshot;
use crate::state::{Landed, Pushed};
use serde_json::Value;

/// Pushes every pending commit; returns how many platform commits were made or adopted,
/// and how many of those an interrupted earlier sync had made.
pub async fn push(co: &mut Checkout) -> Result<(usize, usize)> {
    let commits = co.git.first_parent_since(&co.state.local_base)?;
    let plan = plan::plan(&co.git, &co.state, &commits, &chunk::API)?;
    if plan.steps.is_empty() {
        return Ok((0, 0));
    }
    let trees = plan.trees();
    // Recorded parts of a commit that was interrupted midway, then anything the branch
    // gained after the recorded head (a lost acknowledgment).
    let keep = co
        .state
        .series
        .iter()
        .position(|p| p.commit == plan.start)
        .map_or(0, |i| i + 1);
    let known: Vec<CommitInfo> = co.state.series[keep..]
        .iter()
        .map(|p| CommitInfo {
            commit: p.commit.clone(),
            tree: p.tree.clone(),
            parents: vec![p.parent.clone()],
        })
        .collect();
    let branch = co.state.offline_branch.clone();
    let remote = co.api.branch_head(&branch).await?;
    let limit = trees.len().saturating_sub(known.len());
    let tail = unrecorded(co, remote.as_deref(), &plan.start, limit).await?;
    let unrecorded_count = tail.len();
    let adopted = reconcile::adopt(&[known, tail].concat(), &plan.start, &trees)?;
    if unrecorded_count > 0 {
        human!(
            "Adopted {unrecorded_count} commit(s) an earlier sync made before it was interrupted"
        );
    }
    co.state.series.truncate(keep);
    let (mut parent, mut expected, mut made) = (plan.start.clone(), remote, 0usize);
    for step in plan.steps {
        let Step::Commit {
            local,
            part,
            parts,
            changes,
            tree,
            message,
            author,
            committer,
        } = step
        else {
            if let Step::Empty { local } = step {
                co.state.platform.insert(local, parent.clone());
                co.save()?;
            }
            continue;
        };
        let commit = match adopted.get(made) {
            Some(found) => found.clone(),
            None => {
                let body = changes.iter().map(|c| c.api_json()).collect();
                let created = co
                    .api
                    .create_commit(
                        &parent,
                        co.state.base_version,
                        body,
                        &message,
                        &author,
                        committer.as_ref(),
                    )
                    .await
                    .map_err(|f| {
                        Error::new(format!("committing {local} (part {part} of {parts}): {f}"))
                    })?;
                if created.tree != tree {
                    return Err(Error::new(format!(
                        "the platform built tree {} for {local}, expected {tree}; stopping before it is used",
                        created.tree
                    )));
                }
                co.api
                    .set_branch(&branch, &created.commit, expected.as_deref())
                    .await
                    .map_err(|f| Error::new(format!("moving {branch}: {f}")))?;
                created.commit
            }
        };
        made += 1;
        expected = Some(commit.clone());
        co.state.offline_head = Some(commit.clone());
        co.state.series.push(Pushed {
            commit: commit.clone(),
            tree,
            parent,
        });
        if part == parts {
            co.state.platform.insert(local, commit.clone());
        }
        parent = commit;
        co.save()?;
    }
    Ok((made, unrecorded_count))
}

/// The offline branch's commits after the recorded head (oldest first), walking back
/// from `remote` at most `limit` commits until the recorded head or `start`.
async fn unrecorded(
    co: &Checkout,
    remote: Option<&str>,
    start: &str,
    limit: usize,
) -> Result<Vec<CommitInfo>> {
    let recorded = co.state.offline_head.as_deref();
    let mut found = Vec::new();
    let mut at = remote.map(str::to_owned);
    while let Some(id) = at {
        if Some(id.as_str()) == recorded || id == start {
            break;
        }
        if found.len() == limit {
            return Err(Error::new(format!(
                "{} moved to {} outside this checkout; another client may share it",
                co.state.offline_branch,
                remote.unwrap_or_default()
            )));
        }
        let info = co.api.commit(&id).await?;
        at = info.parents.first().cloned();
        found.push(info);
    }
    found.reverse();
    Ok(found)
}

/// Lands the pushed series on the base branch by landing its tip once: the platform
/// fast-forwards a chain built on the branch head (one log version for the whole series)
/// or merges it onto a moved head, and a retried landing is a no-op. A server that only
/// fast-forwards a commit whose parent is the head refuses the tip with STALE_PARENT;
/// then the series lands one commit at a time, oldest first. Re-pins the checkout after.
pub async fn land(co: &mut Checkout) -> Result<SyncLanding> {
    let commits = co.git.first_parent_since(&co.state.local_base)?;
    let branch = co.state.branch.clone();
    let nothing = SyncLanding {
        commits: 0,
        branch: branch.clone(),
        version: None,
        git_commit: None,
        fast_forwarded: false,
    };
    let Some(tip_local) = commits.last().cloned() else {
        human!(
            "Nothing to land: no local commits since version {}",
            co.state.base_version
        );
        return Ok(nothing);
    };
    let Some(tip) = co.state.series.last().cloned() else {
        human!("Nothing to land: the pending commits change nothing");
        return Ok(nothing);
    };
    let landed = match co.api.land(&branch, &tip.commit).await {
        Err(failure) if failure.code == "STALE_PARENT" && co.state.series.len() > 1 => {
            let mut landed = Value::Null;
            for pushed in co.state.series.clone() {
                landed = landing(
                    co,
                    &branch,
                    &pushed.commit,
                    co.api.land(&branch, &pushed.commit).await,
                )
                .await?;
            }
            landed
        }
        result => landing(co, &branch, &tip.commit, result).await?,
    };
    let version = landed["version"].as_u64();
    let (latest, head) = co
        .api
        .branch_at_latest(&branch)
        .await
        .map_err(at_readback)?;
    let git_commit =
        landed_commit(&landed).or_else(|| (version == Some(latest)).then(|| head.clone()));
    let message = co.snapshot_message(latest, &head);
    let local = snapshot::import(&co.api, &co.git, &head, Some(&tip_local), &message).await?;
    let version = version.unwrap_or(latest);
    co.state.last_land = Some(Landed {
        version,
        git_commit: git_commit.clone(),
    });
    co.state.rebase(latest, &head, &local);
    co.save()?;
    human!(
        "Landed {} commit(s) on {branch} at version {version} (Git commit {})",
        commits.len(),
        git_commit.as_deref().unwrap_or("not projected yet")
    );
    let mut fast_forwarded = false;
    if co.git.run(&["rev-parse", "HEAD"])? == tip_local {
        match co.fast_forward(&local) {
            Ok(()) => fast_forwarded = true,
            Err(e) => {
                human!("Could not fast-forward to {local} ({e}); run `git merge --ff-only {local}`")
            }
        }
    }
    Ok(SyncLanding {
        commits: commits.len() as u64,
        branch,
        version: Some(version),
        git_commit,
        fast_forwarded,
    })
}

/// A landing's answer, or the error to stop with (a conflict is reported with its sides).
async fn landing(
    co: &Checkout,
    branch: &str,
    commit: &str,
    result: std::result::Result<Value, Failure>,
) -> Result<Value> {
    match result {
        Ok(landed) => Ok(landed),
        Err(failure) if failure.code == "CONFLICT" => Err(conflict::report(co, &failure).await?),
        Err(failure) => Err(Error::new(format!(
            "landing {commit} on {branch}: {failure}"
        ))),
    }
}

fn at_readback(failure: Failure) -> Error {
    Error::new(format!(
        "landed, but reading the branch back failed ({failure}); run `yoneda pull`"
    ))
}

/// The Git commit a landing produced, when the platform reported it.
fn landed_commit(landed: &Value) -> Option<String> {
    let text = |field: &str| landed[field].as_str().map(str::to_owned);
    match landed.get("git_commit") {
        // A changeset landing: the projected commit, or null until it is built.
        Some(value) => value.as_str().map(str::to_owned),
        // A merge landing names the merge; a direct landing moved the branch to the commit.
        None => text("merge").or_else(|| text("commit")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_git_commit_each_landing_kind_reports() {
        assert_eq!(
            landed_commit(&json!({ "version": 4, "git_commit": null })),
            None
        );
        assert_eq!(
            landed_commit(&json!({ "git_commit": "g" })).as_deref(),
            Some("g")
        );
        assert_eq!(
            landed_commit(&json!({ "commit": "c", "merge": "m" })).as_deref(),
            Some("m")
        );
        assert_eq!(
            landed_commit(&json!({ "commit": "c" })).as_deref(),
            Some("c")
        );
    }
}
