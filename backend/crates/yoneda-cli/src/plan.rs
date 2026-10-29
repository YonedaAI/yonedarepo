//! Planning a sync: which local commits still need platform commits, split into
//! requests, with the exact tree each platform commit must have.
use crate::changes::{self, Change};
use crate::chunk::{self, Limits};
use crate::error::{Error, Result};
use crate::git::{Git, Trees};
use crate::replay::replay;
use crate::state::State;
use serde_json::{Value, json};

#[derive(Debug)]
pub enum Step {
    /// A local commit that changes nothing: it maps to its parent's platform commit.
    Empty { local: String },
    /// One request; `part == parts` completes `local`.
    Commit {
        local: String,
        part: usize,
        parts: usize,
        changes: Vec<Change>,
        tree: String,
        message: String,
        author: Value,
        /// The local committer, when the platform can rebuild `local` exactly.
        committer: Option<Value>,
    },
}

/// Git's empty tree: what a root commit's changes are taken against.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug)]
pub struct Plan {
    /// The platform commit the first step builds on (empty: the first step is a root
    /// commit, as the first push into an empty repository makes).
    pub start: String,
    pub steps: Vec<Step>,
}

impl Plan {
    /// Trees of the platform commits the plan makes, in order.
    pub fn trees(&self) -> Vec<String> {
        self.steps
            .iter()
            .filter_map(|s| match s {
                Step::Commit { tree, .. } => Some(tree.clone()),
                Step::Empty { .. } => None,
            })
            .collect()
    }
}

/// Which platform commit stands for a local commit (an offline checkout's state, or the
/// remote helper's commit map).
pub trait Mapping {
    fn platform_of(&self, local: &str) -> Option<String>;
}

impl Mapping for State {
    fn platform_of(&self, local: &str) -> Option<String> {
        if local == self.local_base {
            return Some(self.base_commit.clone());
        }
        self.platform.get(local).cloned()
    }
}

fn platform_of(mapping: &dyn Mapping, local: &str) -> Result<String> {
    mapping.platform_of(local).ok_or_else(|| {
        Error::new(format!(
            "local commit {local} has no platform commit; its descendants cannot sync"
        ))
    })
}

/// Plans every commit after the last mapped one in `commits` (oldest first, all after
/// a mapped commit).
pub fn plan(git: &Git, mapping: &dyn Mapping, commits: &[String], limits: &Limits) -> Result<Plan> {
    let first = commits
        .iter()
        .position(|c| mapping.platform_of(c).is_none());
    let Some(first) = first else {
        // No commits: no steps, and nothing builds on `start`.
        let start = match commits.last() {
            Some(last) => platform_of(mapping, last)?,
            None => String::new(),
        };
        return Ok(Plan {
            start,
            steps: Vec::new(),
        });
    };
    let start = match git.first_parent_of(&commits[first])? {
        Some(parent) => platform_of(mapping, &parent)?,
        None => String::new(),
    };
    let mut steps = Vec::new();
    let trees = Trees::new(git);
    for local in &commits[first..] {
        let parent = git
            .first_parent_of(local)?
            .unwrap_or_else(|| EMPTY_TREE.to_owned());
        let chunks = chunk::chunk(changes::between(git, &parent, local)?, limits)?;
        if chunks.is_empty() {
            steps.push(Step::Empty {
                local: local.clone(),
            });
            continue;
        }
        let parts = chunks.len();
        // One request rebuilds the local commit exactly (same id) when it can; a commit
        // split into parts, or one the platform cannot rebuild, gets new platform ids.
        let exact = match parts {
            1 => replay(git, local)?,
            _ => None,
        };
        let authored = git.authored(local)?;
        let author = json!({ "name": authored.name, "email": authored.email });
        let mut tree = parent.clone();
        for (index, changes) in chunks.into_iter().enumerate() {
            let edits = changes
                .iter()
                .map(Change::path_change)
                .collect::<Result<Vec<_>>>()?;
            tree = trees.with(&tree, &edits)?;
            let (message, author, committer) = match &exact {
                Some(r) => (
                    r.message.clone(),
                    r.author.clone(),
                    Some(r.committer.clone()),
                ),
                None if parts == 1 => (authored.message.clone(), author.clone(), None),
                None => (
                    format!("{}\n\n(part {} of {parts})", authored.message, index + 1),
                    author.clone(),
                    None,
                ),
            };
            steps.push(Step::Commit {
                local: local.clone(),
                part: index + 1,
                parts,
                changes,
                tree: tree.clone(),
                message,
                author,
                committer,
            });
        }
        if tree != git.tree_of(local)? {
            return Err(Error::new(format!(
                "rebuilding {local} gave a different tree; nothing was sent"
            )));
        }
    }
    Ok(Plan { start, steps })
}

/// The step for a local merge that changes nothing against its first parent (a conflict
/// resolved to its own side): one commit with no changes, replayed exactly when it can be.
/// [`plan`] maps such a commit to its parent; a caller that sends merge parents uses this.
pub fn merge_step(git: &Git, local: &str) -> Result<Step> {
    let authored = git.authored(local)?;
    let (message, author, committer) = match replay(git, local)? {
        Some(r) => (r.message, r.author, Some(r.committer)),
        None => (
            authored.message,
            json!({ "name": authored.name, "email": authored.email }),
            None,
        ),
    };
    Ok(Step::Commit {
        local: local.to_owned(),
        part: 1,
        parts: 1,
        changes: Vec::new(),
        tree: git.tree_of(local)?,
        message,
        author,
        committer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chunk::ATTEMPT;
    use crate::testkit::Repo;
    use std::collections::BTreeMap;

    fn state_on(base: &str) -> State {
        State {
            repo: "r0123456789abcdef0123".into(),
            origin: "https://example.dev".into(),
            branch: "main".into(),
            base_version: 3,
            base_commit: "p".repeat(40),
            local_base: base.into(),
            offline_branch: "offline/test".into(),
            offline_head: None,
            platform: BTreeMap::new(),
            series: Vec::new(),
            last_land: None,
            attempts: BTreeMap::new(),
        }
    }

    #[test]
    fn splits_a_large_commit_into_a_series_ending_on_its_tree() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("seed.txt", b"seed\n")?;
        let base = repo.commit("base")?;
        for i in 0..3 {
            repo.write(&format!("big/{i}.bin"), &vec![i as u8; 1024 * 1024])?;
        }
        let big = repo.commit("big")?;
        let empty = repo.commit("empty")?;
        let state = state_on(&base);
        let plan = plan(&repo.git, &state, &[big.clone(), empty.clone()], &ATTEMPT)?;
        assert_eq!(plan.start, state.base_commit);
        let parts: Vec<(usize, usize)> = plan
            .steps
            .iter()
            .filter_map(|s| match s {
                Step::Commit { part, parts, .. } => Some((*part, *parts)),
                Step::Empty { .. } => None,
            })
            .collect();
        assert_eq!(parts, [(1, 2), (2, 2)]);
        assert_eq!(plan.trees().last(), Some(&repo.git.tree_of(&big)?));
        assert!(matches!(plan.steps.last(), Some(Step::Empty { local }) if *local == empty));
        // Once mapped, the commit is not planned again; its descendant builds on it.
        let mut mapped = state.clone();
        mapped.platform.insert(big.clone(), "q".repeat(40));
        let rest = super::plan(&repo.git, &mapped, &[big, empty], &ATTEMPT)?;
        assert_eq!(rest.start, "q".repeat(40));
        assert_eq!(rest.steps.len(), 1);
        Ok(())
    }

    struct Nothing;
    impl Mapping for Nothing {
        fn platform_of(&self, _: &str) -> Option<String> {
            None
        }
    }

    #[test]
    fn plans_a_history_from_its_root_commit() -> Result<()> {
        let repo = Repo::new()?;
        repo.write("a.txt", b"a\n")?;
        let root = repo.commit("root")?;
        repo.write("b.txt", b"b\n")?;
        let child = repo.commit("child")?;
        let plan = plan(
            &repo.git,
            &Nothing,
            &[root.clone(), child.clone()],
            &ATTEMPT,
        )?;
        assert_eq!(plan.start, "", "the first step is a root commit");
        assert_eq!(
            plan.trees(),
            [repo.git.tree_of(&root)?, repo.git.tree_of(&child)?]
        );
        let Some(Step::Commit { changes, .. }) = plan.steps.first() else {
            return Err(Error::new("no first step"));
        };
        assert_eq!(changes.len(), 1, "the root adds its one file");
        Ok(())
    }
}
