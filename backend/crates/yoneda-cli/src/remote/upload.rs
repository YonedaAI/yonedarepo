//! Uploading a push: the local commits after the newest one the platform already has
//! become platform commits (chained by parent, none moving a ref). A local merge keeps
//! its other parents when the platform has them, so landing it later sees the merge.
use super::Session;
use super::map::CommitMap;
use crate::chunk;
use crate::error::{Error, Result};
use crate::plan::{self, Mapping, Plan, Step};

/// First-parent commits walked back looking for one the platform has.
const WALK_LIMIT: &str = "100000";

struct Mapped<'a>(&'a CommitMap);

impl Mapping for Mapped<'_> {
    fn platform_of(&self, local: &str) -> Option<String> {
        self.0.server(local).map(str::to_owned)
    }
}

/// The plan for pushing local commit `local`: the commits after its newest first-parent
/// ancestor the platform has.
pub fn plan_for(session: &Session, local: &str) -> Result<Plan> {
    let listed = session.git.run(&[
        "rev-list",
        "--first-parent",
        "--max-count",
        WALK_LIMIT,
        local,
    ])?;
    let mut pending = Vec::new();
    for commit in listed.lines() {
        if session.map.server(commit).is_some() {
            pending.reverse();
            if pending.is_empty() {
                pending.push(commit.to_owned());
            }
            return plan::plan(&session.git, &Mapped(&session.map), &pending, &chunk::API);
        }
        pending.push(commit.to_owned());
    }
    Err(Error::new(format!(
        "{local} shares no commit with {}: clone it and commit on top (or use `yoneda repo import`)",
        session.url.repo
    )))
}

/// A finished upload: the platform commit to publish, and the local commits it made.
pub struct Uploaded {
    pub tip: String,
    pub made: Vec<(String, String)>,
}

/// Uploads `plan` (nothing moves a ref); returns the tip and (server, local) pairs.
pub async fn upload(session: &Session, plan: Plan) -> Result<Uploaded> {
    let base_version = session.map.version(&plan.start);
    let mut parent = plan.start.clone();
    let mut made = Vec::new();
    for step in plan.steps {
        let (local, part, parts, changes, tree, message, author) = match step {
            Step::Empty { local } => {
                made.push((parent.clone(), local));
                continue;
            }
            Step::Commit {
                local,
                part,
                parts,
                changes,
                tree,
                message,
                author,
            } => (local, part, parts, changes, tree, message, author),
        };
        let merges = if part == parts {
            merge_parents(session, &local)?
        } else {
            Vec::new()
        };
        let body = changes.iter().map(|c| c.api_json()).collect();
        let created = session
            .api
            .create_merge_commit(&parent, base_version, body, &message, &author, &merges)
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

/// The platform commits for a local merge's other parents (those the platform has).
fn merge_parents(session: &Session, local: &str) -> Result<Vec<String>> {
    let line = session
        .git
        .run(&["rev-list", "--parents", "-n", "1", local])?;
    Ok(line
        .split_whitespace()
        .skip(2)
        .filter_map(|p| session.map.server(p).map(str::to_owned))
        .collect())
}
