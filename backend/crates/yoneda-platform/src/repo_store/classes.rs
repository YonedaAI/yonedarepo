//! Review classes recorded per commit by the platform classifier (adapter compute), read
//! by landing gates and the review UI. A server-side commit is classified as it is built; a
//! push is not, to keep Git waiting on nothing: its commits are queued, and the classifier
//! asks here which still need a class. Until then they need a human, as any unclassified
//! commit does.
use super::rows;
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Result, git_object::ObjectId};

/// Commits one `repo_classes_pending` asks about.
const PENDING_COMMITS: usize = 32;
/// Changed files listed per commit: one past what the classifier reads for a commit, so it
/// sees a commit is over rather than classifying part of it.
const PENDING_FILES: i64 = 201;

/// `repo_classes_pending {commits}`: those of `commits` recorded here with no class yet, in
/// the order given, each with its changed files.
pub fn pending<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let commits = c["commits"]
        .as_array()
        .filter(|list| !list.is_empty() && list.len() <= PENDING_COMMITS)
        .ok_or_else(|| bad(&format!("commits must list 1-{PENDING_COMMITS} commits")))?;
    let mut pending = Vec::with_capacity(commits.len());
    for commit in commits {
        let id = ObjectId::parse(commit.as_str().unwrap_or_default())?;
        if rows::commit_row(db, &id)?.is_none() || !for_commit(db, &id)?.is_null() {
            continue;
        }
        let touches = db.query(
            "SELECT path,op,old_blob,new_blob,mode FROM commit_paths WHERE commit_id=? ORDER BY path LIMIT ?",
            &[json!(id.hex()), json!(PENDING_FILES)],
        )?;
        pending.push(json!({ "commit": id, "touches": touches }));
    }
    Ok(json!({ "pending": pending }))
}

pub fn record<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = rows::recorded(db, &rows::object_id(c, "commit")?)?.id;
    let overall = string(c, "overall")?;
    let files = c["files"]
        .as_array()
        .ok_or_else(|| bad("files must be a list"))?;
    db.query(
        "INSERT INTO commit_classes(commit_id,overall,files,classified_at) VALUES(?,?,?,?) ON CONFLICT(commit_id) DO NOTHING",
        &[json!(id.hex()), json!(overall), json!(json!(files).to_string()), json!(number(c, "now")?)],
    )?;
    Ok(json!({ "commit": id, "overall": overall }))
}

pub fn for_commit<S: SqlStore>(db: &S, id: &yoneda_core::git_object::ObjectId) -> Result<Value> {
    Ok(db
        .query("SELECT overall,files FROM commit_classes WHERE commit_id=?", &[json!(id.hex())])?
        .first()
        .map(|r| json!({ "overall": r["overall"], "files": serde_json::from_str::<Value>(r["files"].as_str().unwrap_or("[]")).unwrap_or(Value::Null) }))
        .unwrap_or(Value::Null))
}
