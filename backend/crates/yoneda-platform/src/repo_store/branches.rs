//! Working branches: any branch except the protected `main` is created, moved to a
//! recorded commit or deleted by compare-and-swap on its expected old value. Each move
//! appends one `RefMove` (or `RefDelete`) log entry with no paths: it adds no content, so
//! it never fences a landing. `main` moves only by landing (approval and checks) or the
//! human break-glass path, and is never deleted.
use super::rows::{self, branch_ref, current_version, object_id};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{TxEntry, TxKind, chain_digest},
};

pub fn set<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let refname = branch_ref(c)?;
    if rows::protected(&refname) {
        return Err(Error::new(
            "FORBIDDEN",
            "Protected branches move only by landing an approved, checked commit",
        ));
    }
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    let expected = expected_of(c)?;
    let current = rows::ref_value(db, &refname)?;
    if current == Some(commit.id) {
        return Ok(json!({ "ref": refname, "commit": commit.id, "already": true }));
    }
    if current != expected {
        return Err(Error::new(
            "STALE_HEAD",
            format!(
                "{refname} is at {}, not the expected {}",
                current.map_or("nothing".into(), |id| id.hex()),
                expected.map_or("nothing".into(), |id| id.hex())
            ),
        ));
    }
    let version = move_ref(db, c, &refname, current, &commit, principal)?;
    Ok(json!({ "ref": refname, "commit": commit.id, "version": version }))
}

/// Logs `refname` moving from `old` to `commit`, moves it, records its projection target
/// (for the refs the object store mirrors) and checkpoints; returns the log version.
pub(super) fn move_ref<S: SqlStore>(
    db: &S,
    c: &Value,
    refname: &str,
    old: Option<ObjectId>,
    commit: &rows::CommitRow,
    principal: &str,
) -> Result<u64> {
    let (version, chain) = log_move(
        db,
        c,
        refname,
        old,
        Some(commit.id),
        &commit.message,
        principal,
    )?;
    db.query(
        "INSERT INTO refs(name,commit_id,version) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET commit_id=excluded.commit_id,version=excluded.version",
        &[json!(refname), json!(commit.id.hex()), json!(version)],
    )?;
    super::projection::target(db, refname, &commit.id, version, number(c, "now")?)?;
    rows::maybe_checkpoint(db, version, &chain)?;
    Ok(version)
}

/// Deletes a working branch still at its expected value (a missing branch is already gone).
pub fn delete<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let refname = branch_ref(c)?;
    if rows::protected(&refname) {
        return Err(Error::new(
            "FORBIDDEN",
            "Protected branches are never deleted",
        ));
    }
    let current = rows::ref_value(db, &refname)?;
    let Some(old) = current else {
        return Ok(json!({ "ref": refname, "deleted": true, "already": true }));
    };
    if Some(old) != expected_of(c)? {
        return Err(Error::new(
            "STALE_HEAD",
            format!("{refname} is at {old}, not the expected value"),
        ));
    }
    let (version, chain) = log_move(db, c, &refname, current, None, &refname, principal)?;
    db.query("DELETE FROM refs WHERE name=?", &[json!(refname)])?;
    rows::maybe_checkpoint(db, version, &chain)?;
    Ok(json!({ "ref": refname, "deleted": true, "version": version }))
}

/// Appends the hash-chained log entry for a branch moving from `old` to `new` (`None`:
/// deleted) and returns its version and chain digest (the caller moves the ref, then
/// checkpoints).
fn log_move<S: SqlStore>(
    db: &S,
    c: &Value,
    refname: &str,
    old: Option<ObjectId>,
    new: Option<ObjectId>,
    intent: &str,
    principal: &str,
) -> Result<(u64, String)> {
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
        base_version: version - 1,
        kind: if new.is_some() {
            TxKind::RefMove
        } else {
            TxKind::RefDelete
        },
        refname: refname.to_owned(),
        old,
        new,
        paths: Vec::new(),
        read_set: Vec::new(),
        actor: principal.into(),
        intent_digest: yoneda_core::digest(intent.as_bytes()),
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
    Ok((version, entry.chain))
}

/// Most ref updates one batch carries.
const BATCH_LIMIT: usize = 100;

/// An atomic multi-ref push: several working-branch moves (or deletes: a null commit) and
/// tag creations in this one transaction. Every update is validated first (protected refs,
/// immutable tags, recorded commits, no ref twice); if any
/// expected old value is stale, nothing moves and the answer names the stale refs
/// (`{stale}`, an answer rather than an error, so the adapter can report them). Otherwise
/// each moves like `set` (or `tags::create`), in order.
pub fn batch<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let updates = c["updates"]
        .as_array()
        .filter(|u| !u.is_empty() && u.len() <= BATCH_LIMIT)
        .ok_or_else(|| bad("updates must be 1-100 {ref, commit|null, expected}"))?;
    let mut seen = std::collections::BTreeSet::new();
    let mut stale = Vec::new();
    for update in updates {
        if let Some(tag) = super::tags::in_update(update)? {
            if !seen.insert(tag.clone()) {
                return Err(bad(&format!("{tag} appears twice in the batch")));
            }
            super::tags::check(db, update, &tag)?;
            continue;
        }
        let refname = branch_ref(update)?;
        if rows::protected(&refname) {
            return Err(Error::new(
                "FORBIDDEN",
                "Protected branches move only by landing an approved, checked commit",
            ));
        }
        if !seen.insert(refname.clone()) {
            return Err(bad(&format!("{refname} appears twice in the batch")));
        }
        // A null commit deletes the branch.
        let target = match update.get("commit").filter(|v| !v.is_null()) {
            Some(_) => Some(rows::recorded(db, &object_id(update, "commit")?)?.id),
            None => None,
        };
        let expected = expected_of(update)?;
        let current = rows::ref_value(db, &refname)?;
        if current != target && current != expected {
            stale.push(refname);
        }
    }
    if !stale.is_empty() {
        return Ok(json!({ "stale": stale }));
    }
    let mut refs = Vec::with_capacity(updates.len());
    for update in updates {
        let mut command = update.clone();
        command["now"] = c["now"].clone();
        refs.push(if let Some(tag) = super::tags::in_update(update)? {
            super::tags::create_at(db, &command, &tag, principal)?
        } else if update.get("commit").is_none_or(Value::is_null) {
            delete(db, &command, principal)?
        } else {
            set(db, &command, principal)?
        });
    }
    Ok(json!({ "version": current_version(db)?, "refs": refs }))
}

fn expected_of(c: &Value) -> Result<Option<ObjectId>> {
    match c.get("expected").filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(value) => Ok(Some(ObjectId::parse(
            value
                .as_str()
                .ok_or_else(|| bad("expected must be a commit id"))?,
        )?)),
    }
}
