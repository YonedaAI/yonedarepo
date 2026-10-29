//! Rebase planning: which commits of a working branch to replay onto another branch's head,
//! oldest first, each with the trees a three-way merge needs. The adapter replays them
//! (merges in stateless compute, then ordinary commits that move no ref) and moves the
//! branch with one compare-and-swap on the head planned here (`repo_branch_set`), so a
//! push to the branch meanwhile fails the rebase instead of being overwritten.
use super::rows::{self, RecordedGraph, branch_ref, current_version};
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::is_ancestor};

/// Longest series one rebase replays; each commit is a server-side commit and a merge.
const MAX_REPLAYED: usize = 100;

pub fn plan<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    if rows::protected(&refname) {
        return Err(Error::new(
            "FORBIDDEN",
            "Protected branches move only by landing; rebase a working branch onto them",
        ));
    }
    let onto = branch_ref(&json!({ "ref": c.get("onto").cloned().unwrap_or(json!("main")) }))?;
    if onto == refname {
        return Err(bad("A branch cannot be rebased onto itself"));
    }
    let version = current_version(db)?;
    // The two refs now, each refused while it has landed changesets awaiting their Git commit.
    let found = |name: &str| {
        rows::ref_value(db, name)?
            .ok_or_else(|| Error::new("NOT_FOUND", format!("{name} does not exist")))
    };
    let (head, onto_head) = (found(&refname)?, found(&onto)?);
    let graph = RecordedGraph(db);
    let mut answer = json!({ "ref": refname, "head": head, "onto": onto, "onto_head": onto_head,
        "version": version });
    if is_ancestor(&graph, &onto_head, &head)? {
        answer["up_to_date"] = json!(true);
        return Ok(answer);
    }
    // A branch without merges is a first-parent chain down to where it meets `onto`.
    let mut commits = Vec::new();
    let mut at = Some(head);
    while let Some(id) = at {
        if is_ancestor(&graph, &id, &onto_head)? {
            break;
        }
        let row = rows::recorded(db, &id)?;
        if row.parents.len() > 1 {
            return Err(Error::new(
                "NOT_SUPPORTED",
                format!("{id} is a merge commit; rebase replays single-parent commits only"),
            ));
        }
        if commits.len() == MAX_REPLAYED {
            return Err(Error::new(
                "INVALID_INPUT",
                format!("{refname} has more than {MAX_REPLAYED} commits to replay"),
            ));
        }
        let parent = row.parents.first().copied();
        let parent_tree = parent.map(|p| rows::recorded(db, &p)).transpose()?;
        commits.push(json!({ "commit": id, "parent": parent, "tree": row.tree,
            "parent_tree": parent_tree.map(|p| p.tree), "message": row.message }));
        at = parent;
    }
    commits.reverse();
    answer["onto_tree"] = json!(rows::recorded(db, &onto_head)?.tree);
    answer["commits"] = json!(commits);
    Ok(answer)
}
