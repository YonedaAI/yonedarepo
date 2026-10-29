//! `repo_memory_list`: memories newest first, filtered by anchored path, kind, status and
//! source session, each with its staleness; paged by id.
use super::super::rows;
use super::anchors::anchor_path;
use super::records::{MEMORY, judged_ref, kind, memory_json, session_id, version_at, with_anchors};
use super::stale::Staleness;
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::Result;

const DEFAULT_LIMIT: u64 = 50;
const MAX_LIMIT: u64 = 200;
/// Rows examined per list call while filtering on staleness.
const MAX_SCANNED: usize = 2000;

const STATUSES: [&str; 7] = [
    "current",
    "active",
    "stale",
    "draft",
    "retired",
    "superseded",
    "all",
];

fn status_clause(status: &str) -> &'static str {
    match status {
        "current" => "retired_by IS NULL AND superseded_by IS NULL",
        "active" | "stale" => "retired_by IS NULL AND superseded_by IS NULL AND draft=0",
        "draft" => "retired_by IS NULL AND superseded_by IS NULL AND draft=1",
        "retired" => "retired_by IS NOT NULL",
        "superseded" => "retired_by IS NULL AND superseded_by IS NOT NULL",
        _ => "1",
    }
}

fn filter(c: &Value, key: &str, max: usize) -> Result<Option<String>> {
    match &c[key] {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) if s.len() <= max => Ok(Some(s.clone())),
        _ => Err(bad(&format!("{key} must be at most {max} characters"))),
    }
}

/// `repo_memory_list {path?, kind?, status?, session_id?, ref?, at?, before?, limit?}`:
/// memories newest first. `path` keeps those anchored to it, to a directory holding it, or
/// (for a `dir/`) under it; `status` is current (the default: active and drafts), active,
/// stale, draft, retired, superseded or all.
pub fn list<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let at = version_at(db, c)?;
    let refname = judged_ref(c)?;
    let path = filter(c, "path", 4096)?;
    if let Some(path) = &path {
        anchor_path(path)?;
    }
    let kind = match filter(c, "kind", 32)? {
        Some(_) => Some(kind(c)?),
        None => None,
    };
    let session = session_id(c)?;
    let status = filter(c, "status", 16)?.unwrap_or_else(|| "current".into());
    if !STATUSES.contains(&status.as_str()) {
        return Err(bad(&format!(
            "status must be one of {}",
            STATUSES.join(", ")
        )));
    }
    let limit = c["limit"]
        .as_u64()
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);
    let mut cursor = match &c["before"] {
        Value::Null => i64::MAX,
        v => v
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or_else(|| bad("before must be a memory id"))?,
    };
    let sql = format!(
        "SELECT * FROM ({MEMORY} WHERE m.recorded_version<=? AND m.id<? \
         AND (? IS NULL OR m.kind=?) AND (? IS NULL OR m.session_id=?) \
         AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_anchors a WHERE a.memory_id=m.id AND \
           (a.path=? OR (substr(?,-1)='/' AND substr(a.path,1,length(?))=?) \
            OR (substr(a.path,-1)='/' AND substr(?,1,length(a.path))=a.path))))) \
         WHERE {} ORDER BY id DESC LIMIT 200",
        status_clause(&status)
    );
    let mut check = Staleness::new(db, &refname, at);
    let mut memories = Vec::new();
    let mut scanned = 0;
    // Where the next page starts, when more may remain.
    let mut next = None;
    'pages: loop {
        let rows = db.query(
            &sql,
            &[
                json!(at),
                json!(at),
                json!(at),
                json!(cursor),
                json!(kind),
                json!(kind),
                json!(session),
                json!(session),
                json!(path),
                json!(path),
                json!(path),
                json!(path),
                json!(path),
                json!(path),
            ],
        )?;
        let Some(last) = rows.last() else { break };
        cursor = last["id"]
            .as_i64()
            .ok_or_else(|| rows::corrupt("memory id"))?;
        let page = rows.len();
        scanned += page;
        for (row, anchors) in with_anchors(db, rows)? {
            let memory = memory_json(&row, &anchors, Some(&mut check))?;
            if status == "stale" && memory["stale"] != true {
                continue;
            }
            if memories.len() as u64 >= limit {
                next = memories.last().map(|m: &Value| m["id"].clone());
                break 'pages;
            }
            memories.push(memory);
        }
        if page < 200 {
            break;
        }
        if scanned >= MAX_SCANNED {
            next = Some(json!(cursor));
            break;
        }
    }
    Ok(json!({ "version": at, "ref": refname, "memories": memories, "next": next }))
}
