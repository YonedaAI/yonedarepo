//! Forks, as each authority sees them. The adapter (`repo-forks.ts`) runs the steps.
//!
//! Forking: the parent answers its refs at its current version (`repo_fork_source`, read)
//! and pages through the commits those refs reach (`repo_fork_export`); the new fork
//! records them under their own ids with origin `fork` (`repo_fork_record`), then takes
//! the refs (`repo_fork_refs`, logged as imports) and remembers them as copied
//! (`fork_origin`). Objects are never copied: the fork's object store spec names the
//! parent's, and the adapter's reads fall back to it. The parent lists the fork
//! (`repo_fork_register`) and refuses deletion while any fork is left.
//!
//! Access: what a fork serves from its parent is limited to what its own commits reach.
//! Its graph holds only commits reachable from the parent's refs at the fork version (an
//! unlanded or refused commit is never copied), Git fetches and v2 object wants must be
//! reachable from the fork's own refs (`git_wanted`), and file reads start at the fork's
//! refs or commits. Reads that name an object id themselves (`POST /objects`) and a push's
//! check that the objects it omits are already held are where a caller could reach past
//! that: there the adapter requires current read on the parent for inherited objects.
//!
//! A change from a fork: a writer of the fork offers a branch (`repo_fork_offer`); the
//! platform lists the branch's commits the parent lacks (`repo_fork_branch`, haves being
//! the parent's tips and the refs as copied), copies their objects into the parent's store
//! of record, records them there as pushed commits, and moves the parent's mirror branch
//! `forks/<fork>/<branch>` (`repo_fork_mirror`). The change is an ordinary change on that
//! mirror, so reviews, checks and landing (expected-old lease, ancestry) are unchanged.
use super::auth::Actor;
use super::op::ForkOp;
use super::rows::{self, Settings, branch_ref, object_id};
use super::{fork_copy, git_http, land};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, txlog::TxKind};

/// Most commits one change from a fork brings into the parent at a time.
const CHANGE_COMMITS: usize = 500;

pub(super) fn authorize(actor: &Actor, op: ForkOp) -> Result<()> {
    match op {
        // The parent's side of forking: anyone who may read the whole repository.
        ForkOp::Source | ForkOp::Export => {
            actor.require("read")?;
            git_http::whole_repository(actor)
        }
        // Offering a branch to the parent: a writer of the whole fork.
        ForkOp::Offer => {
            actor.require("write")?;
            git_http::whole_repository(actor)
        }
        // A new fork's history and refs: only the platform's fork job fills them.
        ForkOp::Record | ForkOp::Refs if actor.can("import") => Ok(()),
        // Registering forks and carrying changes across: the platform only.
        ForkOp::Register | ForkOp::Forget | ForkOp::Branch | ForkOp::Mirror
            if actor.can("fork") =>
        {
            Ok(())
        }
        ForkOp::Record
        | ForkOp::Refs
        | ForkOp::Register
        | ForkOp::Forget
        | ForkOp::Branch
        | ForkOp::Mirror => Err(Error::new(
            "FORBIDDEN",
            "Only the platform runs this fork step",
        )),
    }
}

pub(super) fn run<S: SqlStore>(
    db: &S,
    c: &Value,
    op: ForkOp,
    actor: &Actor,
    settings: &Settings,
) -> Result<Value> {
    match op {
        ForkOp::Source => fork_copy::source(db, settings),
        ForkOp::Export => fork_copy::export(db, c),
        ForkOp::Record => fork_copy::record(db, c),
        ForkOp::Refs => fork_copy::refs(db, c, &actor.principal),
        ForkOp::Register => register(db, c, true),
        ForkOp::Forget => register(db, c, false),
        ForkOp::Offer => offer(db, c, settings),
        ForkOp::Branch => branch(db, c, actor),
        ForkOp::Mirror => mirror(db, c, &actor.principal),
    }
}

pub(super) fn repo_id(c: &Value, key: &str) -> Result<String> {
    let id = string(c, key)?;
    let valid = id.len() == 21
        && id.starts_with('r')
        && id[1..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(bad(&format!("{key} must be a repository id")));
    }
    Ok(id)
}

/// `repo_init`'s `parent {repo, version}`: set only by the fork job (the adapter builds
/// every `repo_init`; callers never send one).
pub(super) fn parent_of(c: &Value) -> Result<(Option<String>, Option<u64>)> {
    let Some(parent) = c.get("parent").filter(|p| !p.is_null()) else {
        return Ok((None, None));
    };
    let version = parent["version"]
        .as_u64()
        .ok_or_else(|| bad("parent.version must be a log version"))?;
    Ok((Some(repo_id(parent, "repo")?), Some(version)))
}

/// How many live forks read this repository's objects.
pub(super) fn count<S: SqlStore>(db: &S) -> Result<u64> {
    Ok(db.query("SELECT COUNT(*) AS n FROM forks", &[])?[0]["n"]
        .as_u64()
        .unwrap_or_default())
}

/// `repo_fork_register` and `repo_fork_forget {fork}`: the parent's list of live forks.
fn register<S: SqlStore>(db: &S, c: &Value, live: bool) -> Result<Value> {
    let fork = repo_id(c, "fork")?;
    if live {
        db.query(
            "INSERT INTO forks(repo,created_at) VALUES(?,?) ON CONFLICT DO NOTHING",
            &[json!(fork), json!(number(c, "now")?)],
        )?;
    } else {
        db.query("DELETE FROM forks WHERE repo=?", &[json!(fork)])?;
    }
    Ok(json!({ "fork": fork, "forks": count(db)? }))
}

/// `repo_fork_offer {branch}`: a writer of the fork names a branch to propose to the parent.
fn offer<S: SqlStore>(db: &S, c: &Value, settings: &Settings) -> Result<Value> {
    let (parent, _) = settings
        .parent
        .as_ref()
        .ok_or_else(|| bad("This repository is not a fork"))?;
    let refname = branch_ref(&json!({ "ref": c["branch"] }))?;
    let head = rows::projected_ref(db, &refname)?.ok_or_else(|| {
        Error::new(
            "NOT_FOUND",
            format!("No branch {refname} in the fork; push it first"),
        )
    })?;
    Ok(json!({ "parent": parent, "branch": &refname["refs/heads/".len()..], "head": head }))
}

/// `repo_fork_branch {branch, haves}`: the branch's head and the commits the parent lacks,
/// oldest first, each with its tree, parents, first parent's tree and changed paths.
/// `haves` are the parent's tips; the refs as copied count too.
fn branch<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let refname = branch_ref(&json!({ "ref": c["branch"] }))?;
    let head = rows::projected_ref(db, &refname)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("No branch {refname} in the fork")))?;
    let mut haves: Vec<Value> = c["haves"].as_array().cloned().unwrap_or_default();
    for row in db.query("SELECT commit_id FROM fork_origin", &[])? {
        haves.push(row["commit_id"].clone());
    }
    let walk = git_http::walk(db, &json!({ "wants": [head], "haves": haves }), actor)?;
    let mut commits = walk["commits"].as_array().cloned().unwrap_or_default();
    if commits.len() > CHANGE_COMMITS {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A change from a fork carries at most {CHANGE_COMMITS} new commits"),
        ));
    }
    commits.reverse();
    for commit in &mut commits {
        let id = object_id(commit, "commit")?;
        commit["touches"] = json!(rows::touches(db, &id)?);
    }
    Ok(json!({ "head": head, "commits": commits }))
}

/// `repo_fork_mirror {fork, branch, commit}`: moves the parent's `forks/<fork>/<branch>`
/// to the fork branch's head (recorded here already), whatever it held before.
fn mirror<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let fork = repo_id(c, "fork")?;
    let branch = string(c, "branch")?;
    let refname = branch_ref(&json!({ "ref": format!("forks/{fork}/{branch}") }))?;
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    let old = rows::projected_ref(db, &refname)?;
    if old == Some(commit.id) {
        return Ok(json!({ "ref": refname, "commit": commit.id, "already": true }));
    }
    let moved = land::append(db, c, TxKind::RefMove, &refname, old, &commit, principal)?;
    Ok(json!({ "ref": refname, "commit": commit.id, "version": moved["version"] }))
}
