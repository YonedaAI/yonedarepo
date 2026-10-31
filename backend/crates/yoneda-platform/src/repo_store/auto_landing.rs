//! Landings for every push. With the repository's switch on, a branch move opens a change
//! (`origin` = `auto`) in the move's transaction, proposing the branch for `main`. Both ways a
//! working branch moves arrive here: `branches::set` and, for a landing on a working branch,
//! `land::append`. A server-side commit only records, so it moves nothing and isn't one.
//!
//! The row costs nothing: a hook hears it only by asking (`hooks::AUTO_LANDINGS`), and managed
//! agents skip it unless the second switch is on. The two switches are columns of
//! `repo_settings`, set by `repo_auto_landings`, read back in `repo_status`, and not part of
//! `policy`: a policy change alters the digest every recorded check is bound to. A binary that
//! doesn't know them ignores the columns and opens nothing, so rollback is safe.
use super::rows::{self, CommitRow, RecordedGraph};
use super::{change_hooks, changes};
use crate::storage::{SqlStore, bad};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};
use yoneda_core::{
    Result,
    git_object::{ObjectId, is_ancestor},
};

const MAIN: &str = "refs/heads/main";
/// How far behind main's head the walk looks for a commit, in generations. This runs inside
/// a push, so a branch cut from older history skips it: its row is an empty proposal at worst,
/// and the chain and landing checks have already caught what landed.
const WALK: u64 = 256;

/// The repository's two switches, both off until the owner turns them on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, JsonSchema)]
pub struct AutoLandings {
    /// A push opens a Landing.
    pub create: bool,
    /// Managed agents run on those Landings. Off, opening one starts nothing.
    pub agents: bool,
}

fn switch(c: &Value, key: &str) -> Result<Option<bool>> {
    match c.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(value) => match value.as_bool() {
            Some(on) => Ok(Some(on)),
            None => Err(bad(&format!("{key} must be true or false"))),
        },
    }
}

/// `repo_auto_landings {create?, agents?}`: sets the switches it names and answers both.
pub fn set<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let (create, agents) = (switch(c, "create")?, switch(c, "agents")?);
    let rows = db.query(
        "UPDATE repo_settings SET auto_landings=COALESCE(?1,auto_landings),\
         auto_landing_agents=COALESCE(?2,auto_landing_agents) WHERE id='repository' \
         RETURNING auto_landings,auto_landing_agents",
        &[json!(create.map(i64::from)), json!(agents.map(i64::from))],
    )?;
    let row = rows.first().ok_or_else(|| rows::corrupt("repo_settings"))?;
    Ok(json!(AutoLandings {
        create: row["auto_landings"] == 1,
        agents: row["auto_landing_agents"] == 1,
    }))
}

/// The branch's short name, unless a Landing never proposes it: `main`, `release*`, and
/// `forks/*`, whose mirror moves first and whose change the fork's proposal opens.
fn proposable(refname: &str) -> Option<&str> {
    let branch = refname.strip_prefix("refs/heads/")?;
    let skipped = branch == "main" || branch.starts_with("release") || branch.starts_with("forks/");
    (!skipped).then_some(branch)
}

fn switched_on<S: SqlStore>(db: &S) -> Result<bool> {
    let row = db.query("SELECT auto_landings FROM repo_settings", &[])?;
    Ok(row.first().is_some_and(|r| r["auto_landings"] == 1))
}

/// Whether main already holds `commit`: its head, its first-parent chain, a landing there, or
/// nearby through a merge.
fn on_main<S: SqlStore>(db: &S, commit: &CommitRow, head: &ObjectId) -> Result<bool> {
    if commit.id == *head
        || super::ref_chain::depth(db, MAIN, &commit.id)?.is_some()
        || super::land_tickets::landed_version(db, &commit.id, MAIN)?.is_some()
    {
        return Ok(true);
    }
    let Some(tip) = rows::commit_row(db, head)? else {
        return Ok(false);
    };
    let near = tip.generation.saturating_sub(commit.generation) <= WALK;
    Ok(tip.generation >= commit.generation
        && near
        && is_ancestor(&RecordedGraph(db), &commit.id, head)?)
}

/// A person's close stands until it is reopened, unless the branch is new: closing a branch's
/// row and deleting the branch ends that proposal, and work on the same name is another.
fn closed_on<S: SqlStore>(db: &S, branch: &str) -> Result<bool> {
    let newest = db.query(
        "SELECT status FROM changes WHERE branch=? ORDER BY number DESC LIMIT 1",
        &[json!(branch)],
    )?;
    Ok(newest.first().is_some_and(|r| r["status"] == "closed"))
}

/// The commit's subject, or the branch's name when the subject fails a title's rules (empty,
/// too long, not one line, or a credential). `None` if the name fails them too.
fn title_for(commit: &CommitRow, branch: &str) -> Option<String> {
    let subject = commit.message.lines().next().unwrap_or_default();
    [subject, branch]
        .into_iter()
        .find_map(|text| changes::title_of(&json!({ "title": text })).ok().flatten())
}

fn open<S: SqlStore>(
    db: &S,
    branch: &str,
    commit: &CommitRow,
    created: bool,
    principal: &str,
    now: i64,
) -> Result<()> {
    if !switched_on(db)? || changes::open_on(db, branch)?.is_some() {
        return Ok(());
    }
    if !created && closed_on(db, branch)? {
        return Ok(());
    }
    let Some(head) = rows::projected_ref(db, MAIN)? else {
        return Ok(());
    };
    if on_main(db, commit, &head)? {
        return Ok(());
    }
    let Some(title) = title_for(commit, branch) else {
        return Ok(());
    };
    db.query(
        "INSERT INTO changes(title,body,branch,base,author,status,created_at,updated_at,origin) \
         VALUES(?,'',?,'main',?,'open',?,?,'auto')",
        &[
            json!(title),
            json!(branch),
            json!(principal),
            json!(now),
            json!(now),
        ],
    )?;
    let number = db.query("SELECT last_insert_rowid() AS n", &[])?[0]["n"]
        .as_i64()
        .ok_or_else(|| rows::corrupt("change number"))?;
    let change = changes::get(db, number)?;
    change_hooks::notify(db, "change.opened", "opened", &change, None, principal, now)
}

/// `refname` just moved to `commit`, in this transaction (`created`: it did not exist). Opens
/// its Landing if it needs one. Never fails the push: a store error here leaves no row, and
/// `git_change_create` still opens one.
pub(super) fn on_move<S: SqlStore>(
    db: &S,
    refname: &str,
    commit: &CommitRow,
    created: bool,
    principal: &str,
    now: i64,
) {
    if let Some(branch) = proposable(refname) {
        let _ = open(db, branch, commit, created, principal, now);
    }
}
