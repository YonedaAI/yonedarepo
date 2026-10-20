//! Recovering from a lost acknowledgment. Every pushed commit moves this checkout's
//! offline branch by compare-and-swap before the local state records it, so commits the
//! branch holds beyond the recorded head were made by an earlier run that died. They are
//! adopted when they match the plan by parents and tree, never pushed twice.
use crate::api::CommitInfo;
use crate::error::{Error, Result};

/// Matches `tail` (the offline branch's unrecorded commits, oldest first) against the
/// planned trees, starting on `start_parent`; returns the adopted platform commits.
pub fn adopt(
    tail: &[CommitInfo],
    start_parent: &str,
    planned_trees: &[String],
) -> Result<Vec<String>> {
    if tail.len() > planned_trees.len() {
        return Err(foreign(tail.len() - planned_trees.len()));
    }
    let mut parent = start_parent.to_owned();
    let mut adopted = Vec::with_capacity(tail.len());
    for (found, tree) in tail.iter().zip(planned_trees) {
        if found.parents != [parent.clone()] || &found.tree != tree {
            return Err(Error::new(format!(
                "the offline branch holds {} (tree {}), which is not the next planned commit (tree {tree} on {parent}); \
                 another client may share this checkout's offline branch",
                found.commit, found.tree
            )));
        }
        parent = found.commit.clone();
        adopted.push(found.commit.clone());
    }
    Ok(adopted)
}

fn foreign(extra: usize) -> Error {
    Error::new(format!(
        "the offline branch holds {extra} commit(s) beyond this checkout's plan; another client may share it"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(commit: &str, tree: &str, parent: &str) -> CommitInfo {
        CommitInfo {
            commit: commit.into(),
            tree: tree.into(),
            parents: vec![parent.into()],
        }
    }

    fn trees(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn adopts_commits_whose_acknowledgment_was_lost() -> Result<()> {
        // Run 1 pushed c1 and c2 and moved the branch, then died before saving state.
        let tail = [info("c1", "t1", "base"), info("c2", "t2", "c1")];
        let adopted = adopt(&tail, "base", &trees(&["t1", "t2", "t3"]))?;
        assert_eq!(adopted, ["c1", "c2"]);
        // Nothing unrecorded: nothing adopted, everything still to push.
        assert!(adopt(&[], "base", &trees(&["t1"]))?.is_empty());
        Ok(())
    }

    #[test]
    fn refuses_commits_that_do_not_match_the_plan() {
        let wrong_tree = [info("c1", "tX", "base")];
        assert!(adopt(&wrong_tree, "base", &trees(&["t1"])).is_err());
        let wrong_parent = [info("c1", "t1", "elsewhere")];
        assert!(adopt(&wrong_parent, "base", &trees(&["t1"])).is_err());
        let too_many = [info("c1", "t1", "base"), info("c2", "t2", "c1")];
        assert!(adopt(&too_many, "base", &trees(&["t1"])).is_err());
    }
}
