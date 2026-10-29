//! Human-only break-glass recovery (paper Eq. 28). When checks, queues or agent services
//! are down, a signed-in human owner can still land past failing or pending checks, revert
//! a landed commit, release a stuck landing lease and pause automation. Nothing here needs
//! a check runner or queue. Every action needs a reason and is recorded loudly: an audit
//! row, plus a `break-glass:` actor on its log entry. No action rewrites a ref: recovery is
//! a new commit fast-forwarded onto the head the human saw (expected old value).
use super::land::append;
use super::land_gates::gates;
use super::rows::{self, CommitRow, Settings, branch_ref, current_version, object_id};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::{Error, Result, git_object::ObjectId, txlog::TxKind};
mod automation;
pub use automation::{pauses, refuse_if_paused, state};

/// The one refusal every non-human caller gets, whatever its scopes or role.
pub fn refusal() -> Error {
    Error::new(
        "FORBIDDEN",
        "Break-glass recovery is only for a signed-in human owner",
    )
}

/// Break-glass records naming `id` as the landed or the reverted commit.
pub fn for_commit<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Vec<Value>> {
    db.query(
        "SELECT seq,action,refname,commit_id,target_commit,old_commit,version,actor,reason,detail,created_at FROM break_glass WHERE commit_id=? OR target_commit=? ORDER BY seq",
        &[json!(id.hex()), json!(id.hex())],
    )
}

pub fn execute<S: SqlStore>(
    db: &S,
    c: &Value,
    principal: &str,
    settings: &Settings,
) -> Result<Value> {
    let reason = c["reason"]
        .as_str()
        .map(str::trim)
        .filter(|r| !r.is_empty() && r.len() <= 2000)
        .ok_or_else(|| bad("Break-glass needs a reason (up to 2000 characters)"))?;
    let audit = Audit {
        db,
        now: number(c, "now")?,
        principal,
        reason,
    };
    match string(c, "action")?.as_str() {
        "land" => land(&audit, c, settings),
        "revert" => revert(&audit, c, settings),
        "release_land_lease" => automation::release(&audit, c),
        "pause_automation" => automation::pause(&audit, true),
        "resume_automation" => automation::pause(&audit, false),
        _ => Err(bad(
            "action must be land, revert, release_land_lease, pause_automation or resume_automation",
        )),
    }
}

struct Audit<'a, S> {
    db: &'a S,
    now: i64,
    principal: &'a str,
    reason: &'a str,
}

impl<S: SqlStore> Audit<'_, S> {
    fn record(&self, action: &str, row: BTreeMap<&str, Value>, detail: Value) -> Result<i64> {
        let field = |key: &str| row.get(key).cloned().unwrap_or(Value::Null);
        self.db.query(
            "INSERT INTO break_glass(action,refname,commit_id,target_commit,old_commit,version,actor,reason,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            &[json!(action), field("ref"), field("commit"), field("target"), field("old"), field("version"),
              json!(self.principal), json!(self.reason), json!(detail.to_string()), json!(self.now)],
        )?;
        Ok(
            self.db.query("SELECT last_insert_rowid() AS s", &[])?[0]["s"]
                .as_i64()
                .unwrap_or_default(),
        )
    }

    /// Moves `refname` forward from `head` to `commit` with a loudly attributed log entry.
    fn advance(
        &self,
        c: &Value,
        kind: TxKind,
        refname: &str,
        head: Option<ObjectId>,
        commit: &CommitRow,
    ) -> Result<Value> {
        if commit.parents.first() != head.as_ref() {
            return Err(Error::new(
                "STALE_PARENT",
                format!(
                    "Break-glass only fast-forwards {refname}; the commit must sit on its current head"
                ),
            ));
        }
        let actor = format!("break-glass:{}", self.principal);
        append(self.db, c, kind, refname, head, commit, &actor)
    }
}

/// The ref's current value, which must equal the caller's `expected_old` (null: absent).
fn expect_head<S: SqlStore>(db: &S, c: &Value, refname: &str) -> Result<Option<ObjectId>> {
    let expected = match c.get("expected_old") {
        None => {
            return Err(bad(
                "expected_old is required (null when the branch is new)",
            ));
        }
        Some(Value::Null) => None,
        Some(_) => Some(object_id(c, "expected_old")?),
    };
    let current = rows::ref_value(db, refname)?;
    if current != expected {
        return Err(Error::new(
            "STALE_HEAD",
            format!("{refname} moved since you looked; reload and decide again"),
        ));
    }
    Ok(current)
}

fn landed_version<S: SqlStore>(db: &S, id: &ObjectId, refname: &str) -> Result<Option<Value>> {
    Ok(db
        .query(
            "SELECT version FROM landings WHERE commit_id=? AND refname=?",
            &[json!(id.hex()), json!(refname)],
        )?
        .first()
        .map(|r| r["version"].clone()))
}

/// Lands past missing or failing checks and the approval count: the owner's explicit,
/// reasoned act is the approval. A recorded rejection is a human decision and still holds.
fn land<S: SqlStore>(a: &Audit<S>, c: &Value, settings: &Settings) -> Result<Value> {
    let refname = branch_ref(c)?;
    let commit = rows::recorded(a.db, &object_id(c, "commit")?)?;
    if let Some(version) = landed_version(a.db, &commit.id, &refname)? {
        return Ok(
            json!({ "landed": true, "already": true, "ref": refname, "commit": commit.id, "version": version }),
        );
    }
    let head = expect_head(a.db, c, &refname)?;
    let gate = gates(a.db, &commit.id, settings)?;
    if gate["rejected"] == true {
        return Err(Error::new(
            "FORBIDDEN",
            "A reviewer rejected this commit; break-glass does not override human decisions",
        ));
    }
    let mut result = a.advance(c, TxKind::Commit, &refname, head, &commit)?;
    let row = BTreeMap::from([
        ("ref", json!(refname)),
        ("commit", json!(commit.id)),
        ("old", json!(head)),
        ("version", result["version"].clone()),
    ]);
    result["break_glass"] = json!(a.record("land", row, json!({ "bypassed_gates": gate }))?);
    Ok(result)
}

/// Two calls: without `revert_commit` it validates (authority, reason, expected head,
/// target landed) before the adapter writes anything; with it, it verifies that the
/// caller's own new commit is the exact inverse of the target on the head, and lands it.
fn revert<S: SqlStore>(a: &Audit<S>, c: &Value, settings: &Settings) -> Result<Value> {
    let refname = branch_ref(c)?;
    let target = rows::recorded(a.db, &object_id(c, "commit")?)?;
    if landed_version(a.db, &target.id, &refname)?.is_none() {
        return Err(Error::new(
            "NOT_LANDED",
            format!("Only a commit landed on {refname} can be reverted"),
        ));
    }
    let done = a.db.query(
        "SELECT seq,commit_id,version FROM break_glass WHERE action='revert' AND target_commit=? AND refname=?",
        &[json!(target.id.hex()), json!(refname)],
    )?;
    if let Some(row) = done.first() {
        return Ok(
            json!({ "landed": true, "already": true, "ref": refname, "reverted": target.id,
            "commit": row["commit_id"], "version": row["version"], "break_glass": row["seq"] }),
        );
    }
    let head = expect_head(a.db, c, &refname)?;
    let Some(id) = c.get("revert_commit").filter(|v| !v.is_null()) else {
        return Ok(
            json!({ "ready": true, "ref": refname, "head": head, "version": current_version(a.db)? }),
        );
    };
    let commit = rows::recorded(a.db, &ObjectId::parse(id.as_str().unwrap_or_default())?)?;
    if commit.principal != a.principal {
        return Err(Error::new(
            "FORBIDDEN",
            "The revert commit must be built by this owner's break-glass request",
        ));
    }
    if !inverts(a.db, &commit, &target)? {
        return Err(bad(
            "The revert commit is not the exact inverse of the target",
        ));
    }
    let gate = gates(a.db, &commit.id, settings)?;
    let mut result = a.advance(c, TxKind::Revert, &refname, head, &commit)?;
    let row = BTreeMap::from([
        ("ref", json!(refname)),
        ("commit", json!(commit.id)),
        ("target", json!(target.id)),
        ("old", json!(head)),
        ("version", result["version"].clone()),
    ]);
    result["reverted"] = json!(target.id);
    result["break_glass"] = json!(a.record("revert", row, json!({ "bypassed_gates": gate }))?);
    Ok(result)
}

/// Whether `revert` changes exactly the target's paths, each back to its old blob.
fn inverts<S: SqlStore>(db: &S, revert: &CommitRow, target: &CommitRow) -> Result<bool> {
    let undo = rows::touches(db, &revert.id)?;
    let done = rows::touches(db, &target.id)?;
    Ok(!undo.is_empty()
        && undo.len() == done.len()
        && undo.iter().all(|u| {
            done.iter()
                .any(|d| d.path == u.path && d.old_blob == u.new_blob && d.new_blob == u.old_blob)
        }))
}
