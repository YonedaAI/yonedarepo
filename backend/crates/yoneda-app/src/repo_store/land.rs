//! Landing moves a branch with a compare-and-swap and appends one hash-chained log entry.
//! There is no merge lock: if the branch moved, `merging` decides between a conflict
//! (stale read), a platform merge commit, or a stale parent.
use super::merging;
use super::rows::{self, CommitRow, Settings, branch_ref, current_version, object_id};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{TxEntry, TxKind, chain_digest},
};

/// Why a commit can or cannot land under the current policy.
pub fn gates<S: SqlStore>(db: &S, id: &ObjectId, settings: &Settings) -> Result<Value> {
    let reviews = db.query(
        "SELECT decision FROM reviews WHERE commit_id=?",
        &[json!(id.hex())],
    )?;
    let approvals = reviews
        .iter()
        .filter(|r| r["decision"] == "approve")
        .count();
    let rejected = reviews.iter().any(|r| r["decision"] == "reject");
    let checks = db.query(
        "SELECT name,status FROM checks WHERE commit_id=? AND policy_digest=?",
        &[json!(id.hex()), json!(settings.policy_digest)],
    )?;
    let status = |name: &str| {
        checks
            .iter()
            .find(|c| c["name"] == name)
            .map(|c| c["status"].clone())
    };
    let missing: Vec<&String> = settings
        .policy
        .required_checks
        .iter()
        .filter(|n| status(n).is_none())
        .collect();
    let failing: Vec<&String> = settings
        .policy
        .required_checks
        .iter()
        .filter(|n| status(n).is_some_and(|s| s == "fail"))
        .collect();
    let ready = !rejected
        && approvals >= settings.policy.approvals as usize
        && missing.is_empty()
        && failing.is_empty();
    Ok(json!({
        "ready": ready, "approvals": approvals, "approvals_required": settings.policy.approvals,
        "rejected": rejected, "missing_checks": missing, "failing_checks": failing,
    }))
}

fn append<S: SqlStore>(
    db: &S,
    c: &Value,
    kind: TxKind,
    refname: &str,
    old: Option<ObjectId>,
    commit: &CommitRow,
    principal: &str,
) -> Result<Value> {
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
        paths: rows::touches(db, &commit.id)?,
        read_set: commit.read_set.clone(),
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
    super::projection::target(db, refname, &commit.id, version, entry.committed_at_ms)?;
    db.query(
        "INSERT INTO landings(commit_id,refname,version,landed_at) VALUES(?,?,?,?)",
        &[
            json!(commit.id.hex()),
            json!(refname),
            json!(version),
            json!(entry.committed_at_ms),
        ],
    )?;
    Ok(
        json!({ "landed": true, "ref": refname, "commit": commit.id, "version": version, "chain": entry.chain }),
    )
}

pub fn land<S: SqlStore>(db: &S, c: &Value, principal: &str, settings: &Settings) -> Result<Value> {
    let refname = branch_ref(c)?;
    let commit = rows::recorded(db, &object_id(c, "commit")?)?;
    let current = rows::ref_value(db, &refname)?;
    // Already landed (directly, or through a platform merge): a retried land is a no-op.
    let landed = db.query(
        "SELECT version FROM landings WHERE commit_id=? AND refname=?",
        &[json!(commit.id.hex()), json!(refname)],
    )?;
    if current == Some(commit.id) || !landed.is_empty() {
        return Ok(json!({ "landed": true, "already": true, "ref": refname, "commit": commit.id }));
    }
    let gate = gates(db, &commit.id, settings)?;
    if gate["ready"] != true {
        return Err(Error::new(
            "NOT_READY",
            format!("Commit cannot land yet: {gate}"),
        ));
    }
    let Some(head) = current else {
        return append(db, c, TxKind::Commit, &refname, None, &commit, principal);
    };
    if commit.parents.first() == Some(&head) {
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
