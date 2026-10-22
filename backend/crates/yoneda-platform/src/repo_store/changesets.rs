//! Changeset landing (Scion model). A queued landing whose paths are disjoint from
//! everything landed on its branch since its base appends its changeset to the log and
//! advances the branch's version: one indexed query per item, no Git objects and no merge
//! commit. The branch's Git commit at that version is built later by the deterministic
//! projector (`version_projection`). Landings on the same files take the merge path.
use super::land::{append, write_entry};
use super::land_queue::lease;
use super::land_tickets::finish;
use super::merging;
use super::rows::{self, CommitRow, branch_ref};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{OccOutcome, TxEntry, TxKind},
};

const BATCH: u64 = 128;
/// Bound parameters per independence query (Durable Object SQLite caps them per statement).
const QUERY_PARAMS: usize = 90;

/// Whether `refname` has landed changesets whose Git commits are not built yet.
pub fn unprojected<S: SqlStore>(db: &S, refname: &str) -> Result<bool> {
    Ok(!db
        .query(
            "SELECT 1 AS x FROM changesets WHERE refname=? AND projected IS NULL LIMIT 1",
            &[json!(refname)],
        )?
        .is_empty())
}

pub fn any_unprojected<S: SqlStore>(db: &S) -> Result<bool> {
    Ok(!db
        .query(
            "SELECT 1 AS x FROM changesets WHERE projected IS NULL LIMIT 1",
            &[],
        )?
        .is_empty())
}

/// The head new work on `refname` builds on, and the log version it reflects: the last
/// projected head, as of the version before its first unprojected changeset. Work based
/// there is checked against every later changeset when it lands, like any stale base.
pub fn settled_head<S: SqlStore>(db: &S, refname: &str) -> Result<(Option<ObjectId>, u64)> {
    let head = rows::projected_ref(db, refname)?;
    let first = db.query(
        "SELECT MIN(version) AS v FROM changesets WHERE refname=? AND projected IS NULL",
        &[json!(refname)],
    )?[0]["v"]
        .as_u64();
    let version = match first {
        Some(v) => v - 1,
        None => rows::current_version(db)?,
    };
    Ok((head, version))
}

/// Files `entry`'s written paths for independence checks; a ref move without path detail
/// (reset, delete) is filed under the empty path, which every check meets.
pub(super) fn index_paths<S: SqlStore>(db: &S, entry: &TxEntry) -> Result<()> {
    let opaque = entry.paths.is_empty()
        && !matches!(
            entry.kind,
            TxKind::Commit | TxKind::Merge | TxKind::Changeset
        );
    let paths: Vec<&str> = if opaque {
        vec![""]
    } else {
        entry.paths.iter().map(|p| p.path.as_str()).collect()
    };
    for path in paths {
        db.query(
            "INSERT OR IGNORE INTO txlog_paths(refname,path,version) VALUES(?,?,?)",
            &[json!(entry.refname), json!(path), json!(entry.version)],
        )?;
    }
    Ok(())
}

/// SQL conditions (with parameters) matching indexed paths that meet `key`: the path
/// itself, anything under it, and every directory above it. A `dir/` read meets anything
/// under the directory; a `path#symbol` read counts as the whole file here.
fn meeting(key: &str) -> Vec<(&'static str, Vec<Value>)> {
    let key = key.split('#').next().unwrap_or_default();
    let below = |dir: &str| {
        (
            "(path>=? AND path<?)",
            vec![json!(format!("{dir}/")), json!(format!("{dir}0"))],
        )
    };
    if let Some(dir) = key.strip_suffix('/') {
        return vec![below(dir)];
    }
    let mut out = vec![("path=?", vec![json!(key)]), below(key)];
    let mut at = 0;
    while let Some(slash) = key[at..].find('/') {
        at += slash;
        out.push(("path=?", vec![json!(&key[..at])]));
        at += 1;
    }
    out
}

/// Whether an entry on `refname` after `base` wrote a path that meets `keys`, or moved
/// the ref opaquely. One indexed query (more only for very large read sets).
fn touched_since<S: SqlStore>(
    db: &S,
    refname: &str,
    base: u64,
    keys: &BTreeSet<String>,
) -> Result<bool> {
    let mut conditions: Vec<(&str, Vec<Value>)> = vec![("path=''", vec![])];
    conditions.extend(keys.iter().flat_map(|k| meeting(k)));
    let mut start = 0;
    while start < conditions.len() {
        let mut params = vec![json!(refname), json!(base)];
        let mut clauses = Vec::new();
        while start < conditions.len() && params.len() + conditions[start].1.len() <= QUERY_PARAMS {
            clauses.push(conditions[start].0);
            params.extend(conditions[start].1.iter().cloned());
            start += 1;
        }
        let sql = format!(
            "SELECT 1 AS x FROM txlog_paths WHERE refname=? AND version>? AND ({}) LIMIT 1",
            clauses.join(" OR ")
        );
        if !db.query(&sql, &params)?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `refname`'s Git commit as of `version`, when known (an unprojected changeset is not).
fn head_at<S: SqlStore>(db: &S, refname: &str, version: u64) -> Result<Option<ObjectId>> {
    let Some(row) = db
        .query(
            "SELECT t.entry,c.projected FROM txlog t LEFT JOIN changesets c ON c.version=t.version \
             WHERE t.refname=? AND t.version<=? ORDER BY t.version DESC LIMIT 1",
            &[json!(refname), json!(version)],
        )?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let entry: TxEntry = serde_json::from_str(row["entry"].as_str().unwrap_or_default())
        .map_err(|_| rows::corrupt("log entry"))?;
    match entry.kind {
        TxKind::Changeset => row["projected"].as_str().map(ObjectId::parse).transpose(),
        _ => Ok(entry.new),
    }
}

pub(super) enum Route {
    FastForward(Option<ObjectId>),
    /// The branch does not exist yet: the landing creates it at the commit (whose whole
    /// history is recorded first, so it is rooted), as a first push does.
    Create,
    Changeset,
    Merge,
    Fail(Error),
}

fn route<S: SqlStore>(db: &S, refname: &str, commit: &CommitRow) -> Result<Route> {
    let writes = rows::touches(db, &commit.id)?
        .into_iter()
        .map(|t| t.path)
        .collect();
    route_writing(db, refname, commit, &writes, true)
}

/// Routes a landing writing `writes`; `fast_forward` lets a commit on the head land as
/// itself (batched landing always appends a changeset).
pub(super) fn route_writing<S: SqlStore>(
    db: &S,
    refname: &str,
    commit: &CommitRow,
    writes: &BTreeSet<String>,
    fast_forward: bool,
) -> Result<Route> {
    let head = rows::projected_ref(db, refname)?;
    if head.is_none() {
        return Ok(Route::Create);
    }
    let [parent] = commit.parents.as_slice() else {
        return Ok(Route::Merge);
    };
    if fast_forward && head == Some(*parent) && !unprojected(db, refname)? {
        return Ok(Route::FastForward(head));
    }
    // Only a single commit on the branch's head at its base carries its whole changeset
    // in its own touches; anything else (a chain, a merge) takes the merge path.
    if head_at(db, refname, commit.base_version)? != Some(*parent) {
        return Ok(Route::Merge);
    }
    let mut keys = writes.clone();
    keys.extend(commit.read_set.iter().cloned());
    if !touched_since(db, refname, commit.base_version, &keys)? {
        return Ok(Route::Changeset);
    }
    // Something meets it: the exact check decides (symbol reads may still be independent).
    Ok(
        match merging::occ_writing(db, commit, refname, writes.clone())? {
            OccOutcome::Rebase { .. } => Route::Changeset,
            OccOutcome::Merge { .. } | OccOutcome::FastForward => Route::Merge,
            outcome @ OccOutcome::Conflict { .. } => Route::Fail(merging::outcome_error(
                refname,
                &head.unwrap_or(*parent),
                outcome,
            )),
        },
    )
}

/// Appends `commit`'s changeset to `refname`'s log without moving the Git ref.
fn append_changeset<S: SqlStore>(
    db: &S,
    c: &Value,
    refname: &str,
    commit: &CommitRow,
    principal: &str,
) -> Result<u64> {
    let entry = write_entry(db, c, TxKind::Changeset, refname, None, commit, principal)?;
    db.query(
        "INSERT INTO changesets(version,refname,commit_id,landed_at) VALUES(?,?,?,?)",
        &[
            json!(entry.version),
            json!(refname),
            json!(commit.id.hex()),
            json!(entry.committed_at_ms),
        ],
    )?;
    Ok(entry.version)
}

/// `repo_land_changesets`: lands every pending, path-disjoint queued landing on `ref` in
/// one transaction. Items on the same files are marked for the merge path; stale reads
/// fail. Waits while a merge-path builder holds the branch.
pub fn land<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let now = number(c, "now")?;
    if let Some((_, expires)) = lease(db, &refname)?
        && expires > now
    {
        return Ok(json!({ "wait": true, "retry_after_ms": (expires - now).min(250) }));
    }
    let pending = db.query(
        "SELECT ticket,commit_id,principal FROM land_queue WHERE refname=? AND status='pending' AND slow=0 ORDER BY ticket LIMIT ?",
        &[json!(refname), json!(BATCH)],
    )?;
    let (mut landed, mut failed, mut slow, mut deferred) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut batch = merging::BatchWrites::default();
    for row in &pending {
        let ticket = &row["ticket"];
        // The log records who asked to land (authorized when the landing was queued).
        let principal = row["principal"].as_str().unwrap_or_default();
        let commit = rows::recorded(
            db,
            &ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?,
        )?;
        // Write skew within the batch: a member meeting an earlier member's writes waits for
        // the next batch, where log validation (now holding that member) decides it.
        let writes: BTreeSet<String> = rows::touches(db, &commit.id)?
            .into_iter()
            .map(|t| t.path)
            .collect();
        if !batch.admits(&commit.read_set, &writes) {
            deferred.push(ticket.clone());
            continue;
        }
        let result = match route(db, &refname, &commit)? {
            Route::FastForward(head) => {
                let out = append(db, c, TxKind::Commit, &refname, head, &commit, principal)?;
                json!({ "version": out["version"], "commit": commit.id })
            }
            Route::Create => {
                let out = append(db, c, TxKind::Commit, &refname, None, &commit, principal)?;
                json!({ "version": out["version"], "commit": commit.id })
            }
            Route::Changeset => {
                let version = append_changeset(db, c, &refname, &commit, principal)?;
                json!({ "version": version, "commit": null, "changeset": commit.id })
            }
            Route::Merge => {
                db.query(
                    "UPDATE land_queue SET slow=1 WHERE ticket=?",
                    std::slice::from_ref(ticket),
                )?;
                slow.push(ticket.clone());
                continue;
            }
            Route::Fail(error) => {
                let result = json!({ "code": error.code, "message": error.message });
                finish(db, ticket, "failed", result.clone(), now)?;
                failed.push(json!({ "ticket": ticket, "status": "failed", "ref": refname, "result": result }));
                continue;
            }
        };
        batch.accept(writes);
        finish(db, ticket, "landed", result.clone(), now)?;
        landed.push(
            json!({ "ticket": ticket, "status": "landed", "ref": refname, "result": result }),
        );
    }
    Ok(json!({
        "landed": landed, "failed": failed, "slow": slow, "deferred": deferred,
        "more": pending.len() as u64 == BATCH || !deferred.is_empty(),
    }))
}
