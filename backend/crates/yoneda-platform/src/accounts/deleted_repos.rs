//! The repositories an owner deleted and can still restore (the undo window,
//! `repo_store::undo`), one `deleted_repo:<id>` record each. They are the source of D1's
//! `platform_deleted_repos`, which lists them and which the purge sweep reads: D1 can always
//! be rebuilt from here. An entry outlives its org: a deleted org's repositories purge on
//! schedule, and these commands ask no live owner. Only trusted Worker adapters call them.
use super::op::DeletedRepoOp;
use super::repo_names::repo_id;
use super::*;

const PREFIX: &str = "deleted_repo:";

pub(super) fn handle<S: SqlStore>(db: &S, c: &Value, op: DeletedRepoOp) -> Result<Value> {
    match op {
        DeletedRepoOp::Put => {
            let id = repo_id(c)?;
            if !c["entry"].is_object() {
                return Err(bad("entry must be an object"));
            }
            put(db, &format!("{PREFIX}{id}"), &c["entry"])?;
            Ok(json!({ "repo": id }))
        }
        DeletedRepoOp::Remove => {
            let id = repo_id(c)?;
            db.query(
                &format!("DELETE FROM {TABLE} WHERE id=?"),
                &[json!(format!("{PREFIX}{id}"))],
            )?;
            Ok(json!({ "removed": true }))
        }
        DeletedRepoOp::List => {
            let rows = db.query(
                &format!("SELECT id,payload FROM {TABLE} WHERE id GLOB ?||'*' ORDER BY id"),
                &[json!(PREFIX)],
            )?;
            let repos: Result<Vec<Value>> = rows
                .iter()
                .map(|row| {
                    let id = row["id"].as_str().unwrap_or_default();
                    let payload = row["payload"].as_str().unwrap_or_default();
                    let mut entry: Value = serde_json::from_str(payload)
                        .map_err(|e| Error::new("DATABASE", e.to_string()))?;
                    entry["repo"] = json!(id.trim_start_matches(PREFIX));
                    Ok(entry)
                })
                .collect();
            Ok(json!({ "repos": repos? }))
        }
    }
}
