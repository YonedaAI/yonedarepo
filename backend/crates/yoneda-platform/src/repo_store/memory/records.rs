//! Memory records. A memory is at most 2 KiB of text (refused when it holds a credential,
//! like a session summary), one of four kinds, written by a principal against a recorded
//! commit and anchored to up to 20 paths (`dir/` prefixes too) or `path` + `symbol_path`
//! pairs. The adapter resolves each file anchor's blob and each symbol anchor's node digest
//! at that commit; callers never supply them. A memory may name the coding session it came
//! from, and may supersede a live one (which then stops being current); retiring one keeps
//! it, with who retired it and why. A draft is a summary offered for a person to publish
//! (by superseding it) and is never delivered to agents.
use super::super::auth::Actor;
use super::super::rows::{self, object_id};
use super::anchors::{Anchor, anchors};
use super::stale::Staleness;
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub const MAX_TEXT: usize = 2 * 1024;
const MAX_REASON: usize = 500;
const MAX_SESSION_ID: usize = 128;
pub const KINDS: [&str; 4] = ["decision", "constraint", "gotcha", "howto"];

/// A memory as of a log version: the record, whether it was retired or superseded by then,
/// and the newest version that superseded it.
pub(super) const MEMORY: &str = "SELECT m.id,m.kind,m.body,m.commit_id,m.author,m.session_id,m.supersedes,\
    m.draft,m.recorded_at,m.recorded_version,\
    (SELECT MIN(n.id) FROM memories n WHERE n.supersedes=m.id AND n.recorded_version<=?) \
    AS superseded_by,r.reason AS retired_reason,r.principal AS retired_by,r.at AS retired_at \
    FROM memories m LEFT JOIN memory_retirements r ON r.memory_id=m.id AND r.recorded_version<=?";

/// The log version a read is at: `at` when given (not past the log), else the latest.
pub fn version_at<S: SqlStore>(db: &S, c: &Value) -> Result<u64> {
    let current = rows::current_version(db)?;
    match c.get("at").filter(|v| !v.is_null()) {
        None => Ok(current),
        Some(v) => v.as_u64().filter(|v| *v <= current).ok_or_else(|| {
            Error::new(
                "INVALID_INPUT",
                format!("at must be a version from 0 to {current}"),
            )
        }),
    }
}

pub(super) fn kind(c: &Value) -> Result<&'static str> {
    let text = c["kind"].as_str().unwrap_or_default();
    KINDS
        .iter()
        .find(|k| **k == text)
        .copied()
        .ok_or_else(|| bad("kind must be decision, constraint, gotcha or howto"))
}

pub(super) fn session_id(c: &Value) -> Result<Option<String>> {
    match &c["session_id"] {
        Value::Null => Ok(None),
        Value::String(s)
            if !s.is_empty()
                && s.len() <= MAX_SESSION_ID
                && !s.chars().any(|ch| ch.is_control() || ch.is_whitespace()) =>
        {
            Ok(Some(s.clone()))
        }
        _ => Err(bad("session_id must be 1-128 characters without spaces")),
    }
}

fn memory_id(c: &Value, key: &str) -> Result<i64> {
    c[key]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| bad(&format!("{key} must be a memory id")))
}

/// Memories `ids` as of version `at` (in id order), with their anchors.
pub fn load<S: SqlStore>(db: &S, ids: &[i64], at: u64) -> Result<Vec<(Value, Vec<Anchor>)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let list = json!(ids).to_string();
    let rows = db.query(
        &format!(
            "{MEMORY} WHERE m.id IN (SELECT value FROM json_each(?)) AND m.recorded_version<=? \
             ORDER BY m.id"
        ),
        &[json!(at), json!(at), json!(list), json!(at)],
    )?;
    with_anchors(db, rows)
}

pub(super) fn with_anchors<S: SqlStore>(
    db: &S,
    rows: Vec<Value>,
) -> Result<Vec<(Value, Vec<Anchor>)>> {
    let ids: Vec<&Value> = rows.iter().map(|r| &r["id"]).collect();
    let anchor_rows = db.query(
        "SELECT memory_id,path,symbol_path,blob,node_digest FROM memory_anchors \
         WHERE memory_id IN (SELECT value FROM json_each(?)) ORDER BY memory_id,path,symbol_path",
        &[json!(json!(ids).to_string())],
    )?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let anchors = anchor_rows
                .iter()
                .filter(|a| a["memory_id"] == row["id"])
                .map(Anchor::from_row)
                .collect();
            (row, anchors)
        })
        .collect())
}

pub fn status(row: &Value) -> &'static str {
    if !row["retired_by"].is_null() {
        "retired"
    } else if !row["superseded_by"].is_null() {
        "superseded"
    } else if row["draft"] == 1 {
        "draft"
    } else {
        "active"
    }
}

/// A memory as the API answers it; anchors carry their staleness when `stale` is given
/// (current memories only: a retired or superseded one is no longer checked).
pub fn memory_json<S: SqlStore>(
    row: &Value,
    anchors: &[Anchor],
    stale: Option<&mut Staleness<'_, S>>,
) -> Result<Value> {
    let status = status(row);
    let current = matches!(status, "active" | "draft");
    let mut states = Vec::with_capacity(anchors.len());
    match stale.filter(|_| current) {
        Some(check) => {
            let since = row["recorded_version"].as_u64().unwrap_or(0);
            for anchor in anchors {
                states.push(check.anchor(anchor, since)?);
            }
        }
        None => states.resize(anchors.len(), None),
    }
    let stale = if states.contains(&Some(true)) {
        json!(true)
    } else if states.iter().any(Option::is_some) {
        json!(false)
    } else {
        Value::Null
    };
    let retired = (!row["retired_by"].is_null()).then(|| {
        json!({ "reason": row["retired_reason"], "by": row["retired_by"], "at": row["retired_at"] })
    });
    Ok(json!({
        "id": row["id"], "kind": row["kind"], "text": row["body"], "commit": row["commit_id"],
        "author": row["author"], "session_id": row["session_id"],
        "supersedes": row["supersedes"], "superseded_by": row["superseded_by"],
        "status": status, "stale": stale, "retired": retired,
        "recorded_at": row["recorded_at"], "recorded_version": row["recorded_version"],
        "anchors": anchors.iter().zip(states).map(|(a, s)| a.json(s)).collect::<Vec<_>>(),
    }))
}

/// Whether memory `id` exists and is current (neither retired nor superseded) now.
fn current<S: SqlStore>(db: &S, id: i64) -> Result<Value> {
    let at = rows::current_version(db)?;
    let row = load(db, &[id], at)?
        .into_iter()
        .next()
        .map(|(row, _)| row)
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Memory {id} does not exist")))?;
    Ok(row)
}

/// `repo_memory_add {kind, text, commit, anchors?, session_id?, supersedes?, draft?,
/// dry_run?}`. The same memory posted again by the same principal answers the first one.
pub fn add<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let kind = kind(c)?;
    let text = c["text"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= MAX_TEXT)
        .ok_or_else(|| bad("text must be 1-2048 bytes"))?;
    let commit = rows::recorded(db, &object_id(c, "commit")?)?.id;
    let anchors = anchors(c)?;
    let session = session_id(c)?;
    let draft = c["draft"] == true;
    for (field, value) in [("text", Some(text)), ("session_id", session.as_deref())] {
        if let Some(value) = value {
            crate::secret_scan::scan(&format!("memory {field}"), value.as_bytes(), &[])?;
        }
    }
    let supersedes = match &c["supersedes"] {
        Value::Null => None,
        _ if draft => return Err(bad("A draft supersedes nothing")),
        _ => {
            let id = memory_id(c, "supersedes")?;
            let old = current(db, id)?;
            if !matches!(status(&old), "active" | "draft") {
                return Err(Error::new(
                    "CONFLICT",
                    format!("Memory {id} is {} already", status(&old)),
                ));
            }
            Some(id)
        }
    };
    let same = db.query(
        "SELECT id FROM memories WHERE author=? AND kind=? AND body=? AND commit_id=? \
         AND supersedes IS ? AND session_id IS ? AND draft=?",
        &[
            json!(actor.principal),
            json!(kind),
            json!(text),
            json!(commit.hex()),
            json!(supersedes),
            json!(session),
            json!(i64::from(draft)),
        ],
    )?;
    if let Some(row) = same.first() {
        return Ok(json!({ "memory": row["id"], "already": true }));
    }
    if c["dry_run"] == true {
        return Ok(json!({ "dry_run": true, "anchors": anchors.len() }));
    }
    let version = rows::current_version(db)?;
    let id = db.query(
        "INSERT INTO memories(kind,body,commit_id,author,session_id,supersedes,draft,recorded_at,recorded_version) \
         VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
        &[json!(kind), json!(text), json!(commit.hex()), json!(actor.principal), json!(session),
          json!(supersedes), json!(i64::from(draft)), json!(number(c, "now")?), json!(version)],
    )?[0]["id"]
        .as_i64()
        .ok_or_else(|| rows::corrupt("memory id"))?;
    for a in &anchors {
        db.query(
            "INSERT INTO memory_anchors(memory_id,path,symbol_path,blob,node_digest) VALUES(?,?,?,?,?)",
            &[json!(id), json!(a.path), json!(a.symbol_path), json!(a.blob), json!(a.node_digest)],
        )?;
    }
    db.query(
        "INSERT INTO memory_text(rowid,body) VALUES(?,?)",
        &[json!(id), json!(text)],
    )?;
    Ok(json!({ "memory": id, "version": version, "already": false }))
}

/// `repo_memory_retire {id, reason?}`: the memory stays, marked retired from now on.
pub fn retire<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let id = memory_id(c, "id")?;
    let row = current(db, id)?;
    if status(&row) == "retired" {
        return Ok(json!({ "memory": id, "already": true }));
    }
    let reason = super::super::changes::text(c, "reason", MAX_REASON)?;
    let version = rows::current_version(db)?;
    db.query(
        "INSERT INTO memory_retirements(memory_id,reason,principal,at,recorded_version) VALUES(?,?,?,?,?)",
        &[json!(id), json!(reason), json!(actor.principal), json!(number(c, "now")?), json!(version)],
    )?;
    Ok(json!({ "memory": id, "version": version, "already": false }))
}

/// The branch staleness is judged against: `ref` (default main).
pub fn judged_ref(c: &Value) -> Result<String> {
    match c["ref"].as_str().filter(|r| !r.is_empty()) {
        None => Ok("refs/heads/main".into()),
        Some(name) => rows::branch_ref(&json!({ "ref": name })),
    }
}

/// `repo_memory_show {id, at?, ref?}`: one memory with each anchor's staleness.
pub fn show<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = memory_id(c, "id")?;
    let at = version_at(db, c)?;
    let refname = judged_ref(c)?;
    let (row, anchors) = load(db, &[id], at)?.into_iter().next().ok_or_else(|| {
        Error::new(
            "NOT_FOUND",
            format!("Memory {id} does not exist at version {at}"),
        )
    })?;
    let mut check = Staleness::new(db, &refname, at);
    Ok(json!({ "version": at, "ref": refname,
               "memory": memory_json(&row, &anchors, Some(&mut check))? }))
}
