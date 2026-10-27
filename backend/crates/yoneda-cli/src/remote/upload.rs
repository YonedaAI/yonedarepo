//! Uploading a push: the local commits after the newest one the platform already has
//! become platform commits (chained by parent, none moving a ref). Each is replayed with
//! its own author, committer and message, so the platform's commit is the local commit
//! (same id); the rest are mapped. A local merge keeps its other parents when the
//! platform has them, so landing it later sees the merge (also a merge that changes
//! nothing against its first parent). The tip carries the push's
//! declared reads, which landing validates.
use super::Session;
use super::map::CommitMap;
use crate::chunk;
use crate::error::{Error, Result};
use crate::plan::{self, Mapping, Plan, Step};
use crate::snapshot;
use std::collections::HashSet;

/// First-parent commits walked back looking for one the platform has.
const WALK_LIMIT: &str = "100000";
/// Commits asked about in the first presence check; each later one asks eight times more.
const FIRST_CHECK: usize = 16;

/// The platform commit standing for a local one: the map's entry, or the commit itself
/// when the platform has it.
struct Known<'a> {
    map: &'a CommitMap,
    platform: HashSet<String>,
}

impl Mapping for Known<'_> {
    fn platform_of(&self, local: &str) -> Option<String> {
        match self.map.server(local) {
            Some(server) => Some(server.to_owned()),
            None => self.platform.contains(local).then(|| local.to_owned()),
        }
    }
}

/// Which of `commits` the platform has, by the commit map or by asking it.
async fn known<'a>(session: &'a Session, commits: &[String]) -> Result<Known<'a>> {
    let unmapped: Vec<String> = commits
        .iter()
        .filter(|c| session.map.server(c).is_none())
        .cloned()
        .collect();
    Ok(Known {
        map: &session.map,
        platform: snapshot::present(&session.api, &unmapped).await?,
    })
}

/// The plan for pushing local commit `local`: the commits after its newest first-parent
/// ancestor the platform has (asked in growing batches: a short push costs one request).
/// A push creating a branch (`creates`) may bring history the platform has none of: its
/// whole first-parent chain, from the root (the first push into an empty repository).
pub async fn plan_for(session: &Session, local: &str, creates: bool) -> Result<Plan> {
    let listed = session.git.run(&[
        "rev-list",
        "--first-parent",
        "--max-count",
        WALK_LIMIT,
        local,
    ])?;
    let commits: Vec<String> = listed.lines().map(str::to_owned).collect();
    let (mut start, mut size) = (0, FIRST_CHECK);
    while start < commits.len() {
        let end = (start + size).min(commits.len());
        let known = known(session, &commits[start..end]).await?;
        if let Some(found) = commits[start..end]
            .iter()
            .position(|c| known.platform_of(c).is_some())
        {
            let found = start + found;
            let mut pending: Vec<String> = commits[..found].iter().rev().cloned().collect();
            if pending.is_empty() {
                pending.push(commits[found].clone());
            }
            return plan::plan(&session.git, &known, &pending, &chunk::API);
        }
        start = end;
        size *= 8;
    }
    let rooted = match commits.last() {
        Some(oldest) => session.git.first_parent_of(oldest)?.is_none(),
        None => false,
    };
    if creates && rooted {
        let pending: Vec<String> = commits.into_iter().rev().collect();
        let none = Known {
            map: &session.map,
            platform: HashSet::new(),
        };
        let plan = plan::plan(&session.git, &none, &pending, &chunk::API)?;
        if matches!(plan.steps.first(), Some(Step::Empty { .. })) {
            return Err(Error::new(format!(
                "{local}'s root commit is empty: the platform's first commit must add a file"
            )));
        }
        return Ok(plan);
    }
    Err(Error::new(format!(
        "{local} shares no commit with {}: clone it and commit on top (or use `yoneda repo import`)",
        session.url.repo
    )))
}

/// A finished upload: the platform commit to publish, and the (platform, local) pairs of
/// the commits it made (equal ids unless the platform could not rebuild a commit).
pub struct Uploaded {
    pub tip: String,
    pub made: Vec<(String, String)>,
}

/// Uploads `plan` (nothing moves a ref), its last commit declaring `reads`; returns the
/// tip and (server, local) pairs.
pub async fn upload(session: &Session, plan: Plan, reads: &[String]) -> Result<Uploaded> {
    // A root commit (empty start) is based on nothing: version 0.
    let base_version = session.heads.version(&plan.start);
    let steps = with_merges(session, plan.steps).await?;
    let mut parent = plan.start.clone();
    let mut made = Vec::new();
    let last = steps
        .iter()
        .rposition(|(s, _)| matches!(s, Step::Commit { .. }));
    for (index, (step, merges)) in steps.into_iter().enumerate() {
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
                made.push((parent.clone(), local));
            }
            continue;
        };
        let body = changes.iter().map(|c| c.api_json()).collect();
        let created = session
            .api
            .create_merge_commit(
                &parent,
                base_version,
                body,
                &message,
                &author,
                committer.as_ref(),
                &merges,
                if Some(index) == last { reads } else { &[] },
            )
            .await
            .map_err(|f| Error::new(format!("uploading {local} (part {part} of {parts}): {f}")))?;
        if created.tree != tree {
            return Err(Error::new(format!(
                "the platform built tree {} for {local}, expected {tree}; nothing was published",
                created.tree
            )));
        }
        if part == parts {
            made.push((created.commit.clone(), local));
        }
        parent = created.commit;
    }
    Ok(Uploaded { tip: parent, made })
}

/// Each step with the platform parents it merges: a commit's last part carries its other
/// parents. A merge that changes nothing against its first parent (a conflict resolved to
/// its own side) is still uploaded as a merge when the platform has another parent;
/// mapping it to its first parent would drop the merge, and landing would conflict again.
async fn with_merges(session: &Session, steps: Vec<Step>) -> Result<Vec<(Step, Vec<String>)>> {
    let mut out = Vec::with_capacity(steps.len());
    for step in steps {
        let merges = match &step {
            Step::Commit {
                local, part, parts, ..
            } if part == parts => merge_parents(session, local).await?,
            Step::Empty { local } => merge_parents(session, local).await?,
            Step::Commit { .. } => Vec::new(),
        };
        let step = match step {
            Step::Empty { local } if !merges.is_empty() => plan::merge_step(&session.git, &local)?,
            step => step,
        };
        out.push((step, merges));
    }
    Ok(out)
}

/// The platform commits for a local merge's other parents (those the platform has).
async fn merge_parents(session: &Session, local: &str) -> Result<Vec<String>> {
    let line = session
        .git
        .run(&["rev-list", "--parents", "-n", "1", local])?;
    let others: Vec<String> = line.split_whitespace().skip(2).map(str::to_owned).collect();
    let known = known(session, &others).await?;
    Ok(others.iter().filter_map(|p| known.platform_of(p)).collect())
}
