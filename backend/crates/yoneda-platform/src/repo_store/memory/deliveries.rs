//! What context a coding session was shown: the client records each delivery (the session
//! start's packet, the items injected when a file was read, those refreshed for a prompt)
//! with the items it rendered and their size. The session page lists them; a ranking for
//! the same session and caller leaves delivered items out and reports the bytes so far.
//! A prompt is never kept: a prompt delivery's subject is the prompt's SHA-256.
use super::super::auth::Actor;
use super::relevance::TYPES;
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::{Error, Result};

const MAX_ITEMS: usize = 50;
const MAX_BYTES: u64 = 64 * 1024;
/// Deliveries one caller may record for one session (and that a ranking reads back).
const MAX_PER_SESSION: u64 = 1000;
const MAX_LISTED: u64 = 500;
const LABEL: usize = 160;

/// What one caller has delivered to one session so far.
pub struct Delivered {
    pub items: BTreeSet<String>,
    pub bytes: u64,
    pub count: u64,
}

fn session_id(c: &Value) -> Result<String> {
    c["session_id"]
        .as_str()
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && !s.chars().any(|ch| ch.is_control() || ch.is_whitespace())
        })
        .map(str::to_owned)
        .ok_or_else(|| bad("session_id must be 1-128 characters without spaces"))
}

pub fn delivered<S: SqlStore>(db: &S, session: &str, principal: &str) -> Result<Delivered> {
    let rows = db.query(
        "SELECT items,bytes FROM context_deliveries WHERE session_id=? AND principal=? \
         ORDER BY seq LIMIT ?",
        &[json!(session), json!(principal), json!(MAX_PER_SESSION)],
    )?;
    let mut out = Delivered {
        items: BTreeSet::new(),
        bytes: 0,
        count: rows.len() as u64,
    };
    for row in rows {
        out.bytes += row["bytes"].as_u64().unwrap_or(0);
        let items: Vec<Value> =
            serde_json::from_str(row["items"].as_str().unwrap_or("[]")).unwrap_or_default();
        out.items.extend(
            items
                .iter()
                .map(|i| format!("{}:{}", i["type"].as_str().unwrap_or_default(), i["id"])),
        );
    }
    Ok(out)
}

fn items(c: &Value) -> Result<Vec<Value>> {
    let list = c["items"]
        .as_array()
        .filter(|l| l.len() <= MAX_ITEMS)
        .ok_or_else(|| bad("items must be a list of at most 50 {type, id}"))?;
    list.iter()
        .map(|item| {
            let kind = item["type"].as_str().filter(|t| TYPES.contains(t));
            let id = item["id"].as_i64().filter(|n| *n > 0);
            match (kind, id) {
                (Some(kind), Some(id)) => Ok(json!({ "type": kind, "id": id })),
                _ => Err(bad(
                    "Each item is {type: memory|contract|session|change, id}",
                )),
            }
        })
        .collect()
}

/// `repo_context_deliver {session_id, trigger, subject?, items, bytes}`.
pub fn deliver<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let session = session_id(c)?;
    let trigger = c["trigger"].as_str().unwrap_or_default();
    let subject = match (trigger, &c["subject"]) {
        ("start", Value::Null) => Value::Null,
        ("read", Value::String(path)) => {
            yoneda_core::validate_path(path)?;
            json!(path)
        }
        ("prompt", Value::String(digest))
            if digest.len() == 64
                && digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) =>
        {
            json!(digest)
        }
        _ => {
            return Err(bad(
                "trigger is start (no subject), read (subject: the path) or prompt (subject: its SHA-256)",
            ));
        }
    };
    let items = items(c)?;
    let bytes = c["bytes"]
        .as_u64()
        .filter(|b| *b <= MAX_BYTES)
        .ok_or_else(|| bad("bytes must be 0-65536"))?;
    let held = db.query(
        "SELECT COUNT(*) AS n FROM context_deliveries WHERE session_id=? AND principal=?",
        &[json!(session), json!(actor.principal)],
    )?;
    if held[0]["n"].as_u64().unwrap_or(0) >= MAX_PER_SESSION {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A session holds at most {MAX_PER_SESSION} deliveries"),
        ));
    }
    let seq = db.query(
        "INSERT INTO context_deliveries(session_id,trigger,subject,items,bytes,principal,at) \
         VALUES(?,?,?,?,?,?,?) RETURNING seq",
        &[
            json!(session),
            json!(trigger),
            subject,
            json!(json!(items).to_string()),
            json!(bytes),
            json!(actor.principal),
            json!(number(c, "now")?),
        ],
    )?[0]["seq"]
        .clone();
    Ok(json!({ "delivery": seq }))
}

fn cut(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match line.char_indices().nth(LABEL) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line,
    }
}

/// Short labels for the delivered items of one type, by id.
fn labels<S: SqlStore>(db: &S, kind: &str, ids: &[i64]) -> Result<Vec<(i64, String)>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = match kind {
        "memory" => "SELECT id, kind||': '||body AS label FROM memories",
        "contract" => {
            "SELECT seq AS id, path||' `'||symbol_path||'`' AS label FROM symbol_contracts"
        }
        "session" => "SELECT id, cli||': '||summary AS label FROM sessions",
        _ => "SELECT number AS id, '#'||number||' '||title AS label FROM changes",
    };
    let key = match kind {
        "contract" => "seq",
        "change" => "number",
        _ => "id",
    };
    Ok(db
        .query(
            &format!("{sql} WHERE {key} IN (SELECT value FROM json_each(?))"),
            &[json!(json!(ids).to_string())],
        )?
        .iter()
        .filter_map(|r| Some((r["id"].as_i64()?, cut(r["label"].as_str()?))))
        .collect())
}

/// `repo_context_deliveries {session_id}`: what the session was shown, oldest first.
pub fn list<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let session = session_id(c)?;
    let mut rows = db.query(
        "SELECT seq,trigger,subject,items,bytes,principal,at FROM context_deliveries \
         WHERE session_id=? ORDER BY seq LIMIT ?",
        &[json!(session), json!(MAX_LISTED + 1)],
    )?;
    let truncated = rows.len() as u64 > MAX_LISTED;
    rows.truncate(MAX_LISTED as usize);
    let mut parsed = Vec::with_capacity(rows.len());
    for row in &rows {
        let items: Vec<Value> = serde_json::from_str(row["items"].as_str().unwrap_or("[]"))
            .map_err(|_| super::super::rows::corrupt("delivery items"))?;
        parsed.push(items);
    }
    let mut named = std::collections::BTreeMap::new();
    for kind in TYPES {
        let ids: BTreeSet<i64> = parsed
            .iter()
            .flatten()
            .filter(|i| i["type"] == kind)
            .filter_map(|i| i["id"].as_i64())
            .collect();
        for (id, label) in labels(db, kind, &ids.into_iter().collect::<Vec<_>>())? {
            named.insert(format!("{kind}:{id}"), label);
        }
    }
    let deliveries: Vec<Value> = rows
        .iter()
        .zip(parsed)
        .map(|(row, items)| {
            let items: Vec<Value> = items
                .into_iter()
                .map(|mut i| {
                    let key = format!("{}:{}", i["type"].as_str().unwrap_or_default(), i["id"]);
                    i["label"] = json!(named.get(&key));
                    i
                })
                .collect();
            json!({ "seq": row["seq"], "trigger": row["trigger"], "subject": row["subject"],
                    "bytes": row["bytes"], "principal": row["principal"], "at": row["at"],
                    "items": items })
        })
        .collect();
    let bytes: u64 = rows.iter().filter_map(|r| r["bytes"].as_u64()).sum();
    Ok(
        json!({ "session_id": session, "deliveries": deliveries, "bytes": bytes,
               "truncated": truncated }),
    )
}
