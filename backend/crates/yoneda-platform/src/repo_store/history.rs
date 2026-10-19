//! Path history: commits along a branch's first-parent chain that changed a path, newest
//! first, answered from the per-commit changed-path index (no tree walks).
use super::rows::{self, branch_ref};
use crate::storage::{SqlStore, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result, txlog::overlaps};

const MAX_SCAN: usize = 5_000;

pub fn path_history<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let refname = branch_ref(c)?;
    let path = string(c, "path")?;
    let limit = c["limit"].as_u64().unwrap_or(100).clamp(1, 1000) as usize;
    let mut next = rows::ref_value(db, &refname)?
        .ok_or_else(|| Error::new("NOT_FOUND", format!("{refname} does not exist")))?;
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
