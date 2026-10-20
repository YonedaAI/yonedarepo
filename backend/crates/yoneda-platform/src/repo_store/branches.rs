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

pub const PROTECTED: &str = "refs/heads/main";

pub fn set<S: SqlStore>(db: &S, c: &Value, principal: &str) -> Result<Value> {
    let refname = branch_ref(c)?;
    if refname == PROTECTED {
        return Err(Error::new(
            "FORBIDDEN",
            "main moves only by landing an approved, checked commit",
        ));
    }
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    let expected = match c.get("expected").filter(|v| !v.is_null()) {
        None => None,
        Some(value) => Some(ObjectId::parse(
            value
                .as_str()
                .ok_or_else(|| bad("expected must be a commit id"))?,
        )?),
    };
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
    db.query(
        "INSERT INTO refs(name,commit_id,version) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET commit_id=excluded.commit_id,version=excluded.version",
        &[json!(refname), json!(commit.id.hex()), json!(version)],
    )?;
    super::projection::target(db, &refname, &commit.id, version, entry.committed_at_ms)?;
    rows::maybe_checkpoint(db, version, &entry.chain)?;
    Ok(json!({ "ref": refname, "commit": commit.id, "version": version }))
}
