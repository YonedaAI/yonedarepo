//! Filling in who wrote commits recorded before `commits` kept it. The authority holds no
//! commit bytes, so the adapter reads them from the store of record and hands them over here:
//! what counts is the bytes, which must hash to the commit, as a push's do. A commit filled in
//! stays as it is, and one whose bytes are gone stays empty; pages then show who recorded it.
use super::rows::object_id;
use crate::storage::{SqlStore, bad};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{
    Result,
    git_object::{Commit, ObjectKind, hash_object},
};

/// Commits one call fills in.
const PAGE: usize = 200;

/// Who wrote a commit and when (ms), as Git says; none on one not yet filled in.
pub struct Authored {
    pub name: Option<String>,
    pub at: Option<i64>,
}

impl Authored {
    pub(super) fn of(row: &Value) -> Self {
        Self {
            name: row["author_name"].as_str().map(str::to_owned),
            at: row["authored_at"].as_i64(),
        }
    }
}

/// `repo_authors_missing {after?, limit?}`: commits with no author, in id order. `next`: where
/// the next page starts, so that a commit whose bytes are gone never holds a run up.
pub(super) fn missing<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let limit = c["limit"]
        .as_u64()
        .unwrap_or(PAGE as u64)
        .clamp(1, PAGE as u64);
    let rows = db.query(
        "SELECT id FROM commits WHERE authored_at IS NULL AND id>? ORDER BY id LIMIT ?",
        &[json!(c["after"].as_str().unwrap_or_default()), json!(limit)],
    )?;
    let commits: Vec<&Value> = rows.iter().map(|r| &r["id"]).collect();
    let next = (commits.len() as u64 == limit).then(|| commits[commits.len() - 1]);
    Ok(json!({ "commits": commits, "next": next }))
}

/// `repo_authors_set {commits: [{commit, data_b64}]}`: bytes that are not the commit's fill
/// nothing. Answers how many were filled.
pub(super) fn fill<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let items = c["commits"]
        .as_array()
        .filter(|list| list.len() <= PAGE)
        .ok_or_else(|| bad(&format!("commits must list at most {PAGE} commits")))?;
    let mut filled = 0;
    for item in items {
        let id = object_id(item, "commit")?;
        let data = STANDARD
            .decode(item["data_b64"].as_str().unwrap_or_default())
            .map_err(|_| bad("data_b64 is not base64"))?;
        if hash_object(ObjectKind::Commit, &data) != id {
            continue;
        }
        let (author_name, authored_at) = Commit::decode(&data)?.authorship();
        let updated = db.query(
            "UPDATE commits SET author_name=?,authored_at=? WHERE id=? AND authored_at IS NULL RETURNING id",
            &[json!(author_name), json!(authored_at), json!(id.hex())],
        )?;
        filled += updated.len();
    }
    Ok(json!({ "filled": filled }))
}
