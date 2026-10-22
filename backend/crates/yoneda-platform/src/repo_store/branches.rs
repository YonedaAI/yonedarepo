//! Working branches: any branch except the protected `main` is created or moved to a
//! recorded commit by compare-and-swap on its expected old value. Each move appends one
//! `RefMove` log entry with no paths: it adds no content, so it never fences a landing.
//! `main` moves only by landing (approval and checks) or the human break-glass path.
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
        kind: TxKind::RefMove,
        refname: refname.clone(),
        old: current,
        new: Some(commit.id),
        paths: Vec::new(),
        read_set: Vec::new(),
        actor: principal.into(),
        intent_digest: yoneda_core::digest(commit.message.as_bytes()),
        committed_at_ms: number(c, "now")?,
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
        "INSERT INTO refs(name,commit_id,version) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET commit_id=excluded.commit_id,version=excluded.version",
        &[json!(refname), json!(commit.id.hex()), json!(version)],
    )?;
    super::projection::target(db, &refname, &commit.id, version, entry.committed_at_ms)?;
    rows::maybe_checkpoint(db, version, &entry.chain)?;
    Ok(json!({ "ref": refname, "commit": commit.id, "version": version }))
}

/// Most ref updates one batch carries.
const BATCH_LIMIT: usize = 100;

/// An atomic multi-ref push: several working-branch moves in this one transaction. Every
/// update is validated first (protected refs, recorded commits, no ref twice); if any
/// expected old value is stale, nothing moves and the answer names the stale refs
/// (`{stale}`, an answer rather than an error, so the adapter can report them). Otherwise
/// each moves like `set`, in order.
pub fn batch<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let updates = c["updates"]
        .as_array()
        .filter(|u| !u.is_empty() && u.len() <= BATCH_LIMIT)
        .ok_or_else(|| bad("updates must be 1-100 {ref, commit, expected}"))?;
    let mut seen = std::collections::BTreeSet::new();
    let mut stale = Vec::new();
    for update in updates {
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
        let commit = rows::recorded(db, &object_id(update, "commit")?)?;
        let expected = expected_of(update)?;
        let current = rows::ref_value(db, &refname)?;
        if current != Some(commit.id) && current != expected {
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
        refs.push(set(db, &command, principal)?);
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
