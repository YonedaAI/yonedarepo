//! Path history: commits along a branch's first-parent chain that changed a path, newest
//! first, answered from the per-commit changed-path index (no tree walks): the path's own
//! rows joined to the branch's chain (`ref_chain`) where the chain holds the head, else by
//! walking first parents.
use super::rows::{self, branch_ref};
use crate::storage::{SqlStore, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, git_object::ObjectId, txlog::overlaps};

const MAX_SCAN: usize = 5_000;

pub fn path_history<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let path = string(c, "path")?;
    let limit = c["limit"].as_u64().unwrap_or(100).clamp(1, 1000) as usize;
    // From the branch head now, or as of version `at` (time travel, as `log` reads it).
    let head = match c.get("at").filter(|v| !v.is_null()) {
        None => rows::ref_value(db, &refname)?,
        Some(_) => {
            let version = super::reads::at(db, c)?;
            super::reads::refs_at(db, c, version)?.remove(&refname)
        }
    };
    let mut next =
        head.ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
    if let Some(depth) = super::ref_chain::depth(db, &refname, &next)? {
        let commits = from_chain(db, &refname, depth, &path, limit)?;
        return Ok(json!({ "ref": refname, "path": path, "commits": commits }));
    }
    let mut commits = Vec::new();
    for _ in 0..MAX_SCAN {
        let row = rows::recorded(db, &next)?;
        for touch in rows::touches(db, &next)?
            .into_iter()
            .filter(|t| overlaps(&t.path, &path))
        {
            commits.push(json!({
                "commit": next, "path": touch.path, "op": touch.op, "old_blob": touch.old_blob,
                "new_blob": touch.new_blob, "message": row.message, "principal": row.principal,
            }));
        }
        if commits.len() >= limit {
            break;
        }
        match row.parents.first() {
            Some(parent) if rows::commit_row(db, parent)?.is_some() => next = *parent,
            _ => break,
        }
    }
    commits.truncate(limit);
    Ok(json!({ "ref": refname, "path": path, "commits": commits }))
}

/// The touches of `path` (or under it, or of a directory holding it) by commits on
/// `refname`'s chain at or below `depth`, newest first, as the walk lists them.
fn from_chain<S: SqlStore>(
    db: &S,
    refname: &str,
    depth: i64,
    path: &str,
    limit: usize,
) -> Result<Vec<Value>> {
    // Candidates: the path, what lies under it, and the directories holding it; `overlaps`
    // then keeps exactly what the walk would.
    let dir = path.trim_end_matches('/');
    let mut holders: Vec<String> = Vec::new();
    for (at, _) in dir.match_indices('/') {
        holders.push(dir[..at].to_owned());
        holders.push(format!("{}/", &dir[..at]));
    }
    holders.push(path.to_owned());
    let rows = db.query(
        "SELECT p.commit_id,p.path,p.op,p.old_blob,p.new_blob,m.message,m.principal \
         FROM commit_paths p \
         JOIN ref_chain c ON c.ref=? AND c.commit_id=p.commit_id AND c.depth<=? \
         JOIN commits m ON m.id=p.commit_id \
         WHERE p.path IN (SELECT value FROM json_each(?)) OR (p.path>? AND p.path<?) \
         ORDER BY c.depth DESC, p.path LIMIT ?",
        &[
            json!(refname),
            json!(depth),
            json!(json!(holders).to_string()),
            json!(format!("{dir}/")),
            json!(format!("{dir}0")),
            json!(limit),
        ],
    )?;
    let mut commits = Vec::new();
    for row in rows {
        let touched = row["path"].as_str().unwrap_or_default();
        if !overlaps(touched, path) {
            continue;
        }
        let commit = ObjectId::parse(row["commit_id"].as_str().unwrap_or_default())?;
        commits.push(json!({
            "commit": commit, "path": touched, "op": row["op"], "old_blob": row["old_blob"],
            "new_blob": row["new_blob"], "message": row["message"], "principal": row["principal"],
        }));
    }
    Ok(commits)
}
