//! Landing work whose branch moved: the authority decides (stale read: conflict; other
//! files: rebase; same files: three-way merge), the adapter builds the platform merge
//! commit with Rust compute, and the authority verifies that merge before landing it
//! under the merged commit's own approvals and checks.
use super::rows::{self, CommitRow, RecordedGraph, branch_ref, current_version, object_id};
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::{ObjectId, is_ancestor, merge_bases},
    txlog::{OccOutcome, Proposal, overlaps},
};

/// Principal of merge commits the platform computes; only these land under another
/// commit's gates.
pub const MERGE_PRINCIPAL: &str = "platform:merge";

pub fn occ<S: SqlStore>(db: &S, commit: &CommitRow, refname: &str) -> Result<OccOutcome> {
    let proposal = Proposal {
        refname: refname.into(),
        base_version: commit.base_version,
        expected_old: commit.parents.first().copied(),
        write_set: rows::touches(db, &commit.id)?
            .into_iter()
            .map(|t| t.path)
            .collect(),
        read_set: commit.read_set.iter().cloned().collect(),
    };
    let later = rows::entries(db, commit.base_version, current_version(db)?, Some(refname))?;
    Ok(proposal.check(&later, &super::symbols::refinements(db, &later)?))
}

pub fn outcome_error(refname: &str, head: &ObjectId, outcome: OccOutcome) -> Error {
    match outcome {
        OccOutcome::Conflict { version, paths } => Error::new(
            "CONFLICT",
            format!(
                "{refname} changed at version {version} on {}, which this commit read; reconcile and re-check",
                paths.join(", ")
            ),
        ),
        OccOutcome::Rebase { concurrent } => Error::new(
            "MERGE_REQUIRED",
            format!(
                "{refname} moved independently at versions {concurrent:?}; a merge commit is required"
            ),
        ),
        OccOutcome::Merge { concurrent, paths } => Error::new(
            "MERGE_REQUIRED",
            format!(
                "{refname} also changed {} at versions {concurrent:?}; a three-way merge is required",
                paths.join(", ")
            ),
        ),
        OccOutcome::FastForward => Error::new(
            "STALE_PARENT",
            format!("{refname} is at {head}, which is not this commit's parent"),
        ),
    }
}

/// What the adapter needs to compute a merge of `commit` into `ref`.
pub fn plan<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    let head = rows::ref_value(db, &refname)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
    let head_row = rows::recorded(db, &head)?;
    let base = merge_bases(&RecordedGraph(db), &head, &commit.id)?
        .into_iter()
        .next();
    let base_tree = base
        .map(|b| rows::recorded(db, &b).map(|r| r.tree))
        .transpose()?;
    let outcome = occ(db, &commit, &refname)?;
    let (kind, paths) = match &outcome {
        OccOutcome::FastForward if commit.parents.first() == Some(&head) => {
            ("fast_forward", vec![])
        }
        OccOutcome::FastForward => ("stale", vec![]),
        OccOutcome::Rebase { .. } => ("rebase", vec![]),
        OccOutcome::Merge { paths, .. } => ("merge", paths.clone()),
        OccOutcome::Conflict { paths, .. } => ("conflict", paths.clone()),
    };
    Ok(json!({
        "ref": refname, "version": current_version(db)?, "outcome": kind, "paths": paths,
        "head": head, "head_tree": head_row.tree, "commit": commit.id, "commit_tree": commit.tree,
        "base": base, "base_tree": base_tree,
    }))
}

/// Paths written by commits reachable from `tip` but not from `head` (bounded walk).
pub fn branch_paths<S: SqlStore>(
    db: &S,
    tip: &ObjectId,
    head: &ObjectId,
) -> Result<BTreeSet<String>> {
    let graph = RecordedGraph(db);
    let mut paths = BTreeSet::new();
    let mut stack = vec![*tip];
    let mut seen = BTreeSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) || is_ancestor(&graph, &id, head)? {
            continue;
        }
        if seen.len() > 10_000 {
            return Err(Error::new(
                "TOO_LARGE",
                "Branch history is too long to merge",
            ));
        }
        paths.extend(rows::touches(db, &id)?.into_iter().map(|t| t.path));
        stack.extend(yoneda_core::git_object::CommitGraph::parents(&graph, &id)?);
    }
    Ok(paths)
}

/// Verifies a platform merge commit `merge` of `commit` onto `head` before it lands.
pub fn verify<S: SqlStore>(
    db: &S,
    refname: &str,
    head: &ObjectId,
    commit: &CommitRow,
    merge: &CommitRow,
) -> Result<()> {
    if merge.parents != [*head, commit.id] {
        return Err(Error::new(
            "STALE_PARENT",
            format!("The merge commit is not based on the current head of {refname}"),
        ));
    }
    if merge.principal != MERGE_PRINCIPAL {
        return Err(Error::new(
            "FORBIDDEN",
            "Only platform merge commits land under another commit's gates",
        ));
    }
    match occ(db, commit, refname)? {
        OccOutcome::Rebase { .. } | OccOutcome::Merge { .. } => {}
        other => return Err(outcome_error(refname, head, other)),
    }
    let allowed = branch_paths(db, &commit.id, head)?;
    if let Some(extra) = rows::touches(db, &merge.id)?
        .into_iter()
        .find(|t| !allowed.contains(&t.path))
    {
        return Err(Error::new(
            "FORBIDDEN",
            format!(
                "The merge commit changes {}, which the merged work did not",
                extra.path
            ),
        ));
    }
    Ok(())
}

/// Write skew inside one batch (Adya G2-item): members land in ticket order, so a member
/// may neither read nor write a path an earlier accepted member of the same batch wrote
/// (paths overlap as in log validation: a directory meets the paths under it). A member
/// with no declared reads counts its writes as reads. Log validation alone misses this:
/// each member is checked against the log since its own base, not against its batch.
#[derive(Default)]
pub struct BatchWrites(Vec<String>);

impl BatchWrites {
    /// Whether a member reading `reads` and writing `writes` may join after the members
    /// accepted so far.
    pub fn admits(&self, reads: &[String], writes: &BTreeSet<String>) -> bool {
        let file = |p: &String| p.split('#').next().unwrap_or_default().to_owned();
        !reads
            .iter()
            .map(file)
            .chain(writes.iter().cloned())
            .any(|key| self.0.iter().any(|w| overlaps(&key, w)))
    }
    /// Records an accepted (landed) member's writes.
    pub fn accept(&mut self, writes: BTreeSet<String>) {
        self.0.extend(writes);
    }
}
