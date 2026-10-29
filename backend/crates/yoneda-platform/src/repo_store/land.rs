//! Landing moves a branch with a compare-and-swap and appends one hash-chained log entry.
//! There is no merge lock: if the branch moved, `merging` decides between a conflict
//! (stale read), a platform merge commit, or a stale parent.
//!
//! `git_land` takes no expected-old by design: the caller names a commit, not the branch
//! value it saw. The compare-and-swap is against the branch inside this transaction, and
//! the commit's base version and read set are checked against the log entries after it.
//! A commit begun from the published head (`begin_from_head`, `repo-commit-shard.ts`) never
//! called the authority, so landing is its first optimistic-concurrency check. A stock
//! `git push` differs: each ref command carries Git's old id as an expected-old lease
//! (`platform_git_receive`).
use super::land_gates::require_gates;
use super::land_tickets::landed_version;
use super::rows::{self, CommitRow, Settings, branch_ref, current_version, object_id};
use super::{changes, merging};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{TxEntry, TxKind, chain_digest},
};

/// Writes the log entry for `commit` landing on `refname` (hash-chained, path-indexed)
/// and its landing record; the caller moves the ref, or leaves it to the projector.
pub(super) fn write_entry<S: SqlStore>(
    db: &S,
    c: &Value,
    kind: TxKind,
    refname: &str,
    old: Option<ObjectId>,
    commit: &CommitRow,
    principal: &str,
) -> Result<TxEntry> {
    let paths = rows::touches(db, &commit.id)?;
    write_entry_with(db, c, kind, refname, old, commit, paths, principal)
}

/// `write_entry` with the commit's path touches given (a commit not adopted here).
#[allow(clippy::too_many_arguments)]
pub(super) fn write_entry_with<S: SqlStore>(
    db: &S,
    c: &Value,
    kind: TxKind,
    refname: &str,
    old: Option<ObjectId>,
    commit: &CommitRow,
    paths: Vec<yoneda_core::txlog::PathTouch>,
    principal: &str,
) -> Result<TxEntry> {
    let version = current_version(db)? + 1;
    let previous = db
        .query(
            "SELECT chain FROM txlog WHERE version=?",
            &[json!(version - 1)],
        )?
        .first()
        .and_then(|r| r["chain"].as_str().map(str::to_owned))
        .unwrap_or_default();
    let mut entry = TxEntry {
        version,
        base_version: commit.base_version.min(version - 1),
        kind,
        refname: refname.into(),
        old,
        new: Some(commit.id),
        paths,
        read_set: commit.read_set.clone(),
        actor: principal.into(),
        intent_digest: yoneda_core::digest(commit.message.as_bytes()),
        committed_at_ms: number(c, "now")?,
        checkpoint_refs: rows::refs_digest_at(db, version - 1)?,
        chain: String::new(),
    };
    entry.chain = chain_digest(&previous, &entry)?;
    entry.validate(&previous)?;
    let encoded =
        serde_json::to_string(&entry).map_err(|e| Error::new("ENCODING", e.to_string()))?;
    db.query(
        "INSERT INTO txlog(version,refname,entry,chain) VALUES(?,?,?,?)",
        &[
            json!(version),
            json!(refname),
            json!(encoded),
            json!(entry.chain),
        ],
    )?;
    super::changesets::index_paths(db, &entry)?;
    db.query(
        "INSERT INTO landings(commit_id,refname,version,landed_at) VALUES(?,?,?,?)",
        &[
            json!(commit.id.hex()),
            json!(refname),
            json!(version),
            json!(entry.committed_at_ms),
        ],
    )?;
    changes::landed(db, &commit.id, refname, version, entry.committed_at_ms)?;
    Ok(entry)
}

pub(super) fn append<S: SqlStore>(
    db: &S,
    c: &Value,
    kind: TxKind,
    refname: &str,
    old: Option<ObjectId>,
    commit: &CommitRow,
    principal: &str,
) -> Result<Value> {
    // A fast-forward over a chain logs the chain's whole changeset, not the tip's alone.
    let paths = match old {
        Some(head) if kind == TxKind::Commit && commit.parents.first() != Some(&head) => {
            merging::chain_touches(db, &commit.id, &head)?
        }
        _ => rows::touches(db, &commit.id)?,
    };
    let entry = write_entry_with(db, c, kind, refname, old, commit, paths, principal)?;
    let version = entry.version;
    db.query(
        "INSERT INTO refs(name,commit_id,version) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET commit_id=excluded.commit_id,version=excluded.version",
        &[json!(refname), json!(commit.id.hex()), json!(version)],
    )?;
    super::ref_chain::advance(db, refname, &commit.id)?;
    super::projection::target(db, refname, &commit.id, version, entry.committed_at_ms)?;
    rows::maybe_checkpoint(db, version, &entry.chain)?;
    Ok(
        json!({ "landed": true, "ref": refname, "commit": commit.id, "version": version, "chain": entry.chain }),
    )
}

pub fn land<S: SqlStore>(db: &S, c: &Value, principal: &str, settings: &Settings) -> Result<Value> {
    let refname = branch_ref(c)?;
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    // Read past unprojected changesets: they only route this landing (below).
    let current = rows::projected_ref(db, &refname)?;
    // Already landed (directly, or through a platform merge): a retried land is a no-op.
    if current == Some(commit.id) || landed_version(db, &commit.id, &refname)?.is_some() {
        return Ok(json!({ "landed": true, "already": true, "ref": refname, "commit": commit.id }));
    }
    require_gates(db, &commit.id, &refname, settings)?;
    // A fast-forward-only landing compares against the latest version: the adapter projects
    // the pending changesets and retries. Any other landing queues behind them.
    let unprojected = super::changesets::unprojected(db, &refname)?;
    if unprojected && c["fast_forward_only"] == true {
        return Err(rows::projection_pending(&refname));
    }
    // While a group landing owns this branch, direct landings queue behind it.
    if unprojected || super::land_queue::busy(db, &refname, number(c, "now")?)? {
        return Err(Error::new(
            "MERGE_REQUIRED",
            format!("{refname} has queued landings; this commit joins the queue"),
        ));
    }
    let Some(head) = current else {
        return append(db, c, TxKind::Commit, &refname, None, &commit, principal);
    };
    let on_head = merging::on_head(db, &commit, &head)?;
    if !on_head && c["fast_forward_only"] == true {
        return Err(Error::new(
            "STALE_HEAD",
            format!("{refname} moved to {head}; refresh the commit onto it before landing"),
        ));
    }
    if on_head {
        return append(
            db,
            c,
            TxKind::Commit,
            &refname,
            Some(head),
            &commit,
            principal,
        );
    }
    if let Some(merge) = c.get("merge").filter(|m| !m.is_null()) {
        let merge = rows::recorded(db, &ObjectId::parse(merge.as_str().unwrap_or_default())?)?;
        merging::verify(db, &refname, &head, &commit, &merge)?;
        // The merge lands under the merged commit's read set and base; both are landed.
        let landed_as = CommitRow {
            read_set: commit.read_set.clone(),
            base_version: commit.base_version,
            ..merge
        };
        let mut result = append(
            db,
            c,
            TxKind::Merge,
            &refname,
            Some(head),
            &landed_as,
            principal,
        )?;
        db.query(
            "INSERT INTO landings(commit_id,refname,version,landed_at) VALUES(?,?,?,?)",
            &[
                json!(commit.id.hex()),
                json!(refname),
                result["version"].clone(),
                c["now"].clone(),
            ],
        )?;
        changes::landed(
            db,
            &commit.id,
            &refname,
            current_version(db)?,
            number(c, "now")?,
        )?;
        result["merged"] = json!(commit.id);
        return Ok(result);
    }
    Err(merging::outcome_error(
        &refname,
        &head,
        merging::occ(db, &commit, &refname)?,
    ))
}

/// Seeds an empty repository with a root commit. Owner-only (checked by the dispatcher)
/// and gate-free by design.
pub fn import<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    if !db.query("SELECT name FROM refs LIMIT 1", &[])?.is_empty() {
        return Err(Error::new(
            "ALREADY_EXISTS",
            "Import is only for an empty repository",
        ));
    }
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    if !commit.parents.is_empty() && !super::history_import::imported(db, &commit.id)? {
        return Err(Error::new(
            "INVALID_INPUT",
            "Import needs a root commit or imported history",
        ));
    }
    append(
        db,
        c,
        TxKind::Import,
        &branch_ref(c)?,
        None,
        &commit,
        principal,
    )
}
