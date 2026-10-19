//! Landing moves a branch with a compare-and-swap and appends one hash-chained log entry.
//! There is no merge lock: a moved branch is checked for independence (Eq. 1 read/write
//! sets); independent work needs a server merge (N3), overlapping work a reconcile.
use super::rows::{self, CommitRow, Settings, branch_ref, current_version, object_id};
use crate::storage::{SqlStore, number};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{OccOutcome, Proposal, TxEntry, TxKind, chain_digest},
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
    if current == Some(commit.id) {
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
    let proposal = Proposal {
        refname: refname.clone(),
        base_version: commit.base_version,
        expected_old: commit.parents.first().copied(),
        write_set: rows::touches(db, &commit.id)?
            .into_iter()
            .map(|t| t.path)
            .collect(),
        read_set: commit.read_set.iter().cloned().collect(),
    };
    let later = rows::entries(
        db,
        commit.base_version,
        current_version(db)?,
        Some(&refname),
    )?;
    Err(match proposal.check(&later) {
        OccOutcome::Conflict { version, paths } => Error::new(
            "CONFLICT",
            format!(
                "{refname} changed at version {version} on {}; reconcile and re-check",
                paths.join(", ")
            ),
        ),
        OccOutcome::Rebase { concurrent } => Error::new(
            "MERGE_REQUIRED",
            format!(
                "{refname} moved independently at versions {concurrent:?}; a server merge commit is required"
            ),
        ),
        OccOutcome::FastForward => Error::new(
            "STALE_PARENT",
            format!("{refname} is at {head}, which is not this commit's parent"),
        ),
    })
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
    if !commit.parents.is_empty() {
        return Err(Error::new("INVALID_INPUT", "Import needs a root commit"));
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
