//! Repository-wide reads of what agents record, for the web's agent pages: session records
//! (newest first, filtered by CLI, model or branch), one session with its commit and the
//! other commits of the same session, authored contract records, pins and bisects. All are
//! read-only. Sessions, pins and bisects describe whole commits, so a path-restricted token
//! reads none of them; contract records are filtered to the grant (`grants::redact`).
use super::auth::Actor;
use super::rows::{branch_ref, corrupt};
use super::session_range::{commit_param, range};
use super::sessions::{stored_transcript, whole_repository};
use crate::storage::{SqlStore, bad};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

const DEFAULT_LIMIT: u64 = 50;
const MAX_LIMIT: u64 = 200;
/// Declared reads shown with one session.
const MAX_READS: usize = 500;
const SESSION_COLUMNS: &str = "s.id,s.commit_id,s.cli,s.model,s.summary,s.prompt_digest,\
    s.transcript_ref,s.read_set_digest,s.recorded_by,s.at,s.session_id,s.transcript,c.message,\
    c.read_set";

fn limit(c: &Value) -> u64 {
    c["limit"]
        .as_u64()
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}

/// The `before` cursor: rows with a smaller id or seq than this one.
fn before(c: &Value) -> Result<i64> {
    match &c["before"] {
        Value::Null => Ok(i64::MAX),
        v => v
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or_else(|| bad("before must be a positive id")),
    }
}

fn subject(message: &Value) -> String {
    message
        .as_str()
        .unwrap_or_default()
        .lines()
        .next()
        .unwrap_or_default()
        .to_owned()
}

/// One session row as the API answers it: the record, its commit's subject line and how
/// many reads the commit declared.
pub(super) fn session(row: &Value) -> Result<Value> {
    let reads: Vec<String> = serde_json::from_str(row["read_set"].as_str().unwrap_or("[]"))
        .map_err(|_| corrupt("read set"))?;
    Ok(json!({
        "id": row["id"], "commit": row["commit_id"], "cli": row["cli"],
        "model": super::sessions::shown_model(&row["model"]),
        "summary": row["summary"], "prompt_digest": row["prompt_digest"],
        "transcript_ref": row["transcript_ref"], "read_set_digest": row["read_set_digest"],
        "recorded_by": row["recorded_by"], "at": row["at"], "session_id": row["session_id"],
        "transcript": stored_transcript(&row["transcript"])?,
        "subject": subject(&row["message"]), "reads": reads.len(),
    }))
}

fn filter_value(c: &Value, key: &str) -> Result<Option<String>> {
    match &c[key] {
        Value::Null => Ok(None),
        Value::String(s) if s.is_empty() => Ok(None),
        Value::String(s) if s.len() <= 128 => Ok(Some(s.clone())),
        _ => Err(bad(&format!("{key} must be at most 128 characters"))),
    }
}

/// `repo_session_list`: `{cli?, model?, session_id?, ref?, head?, base?, before?, limit?}`.
/// Session records newest first (`session_id`: one coding session's), a `next` cursor when more remain, and the CLIs and models seen (for
/// filters). `ref` or `head` (a commit) keeps the commits they reach, less what `base` reaches:
/// a change's head and merge base give the sessions behind the commits it introduces.
pub fn session_list<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let cli = filter_value(c, "cli")?;
    let model = filter_value(c, "model")?;
    let session_id = filter_value(c, "session_id")?;
    let branch = match filter_value(c, "ref")? {
        Some(name) => Some(branch_ref(&json!({ "ref": name }))?),
        None => None,
    };
    let head = commit_param(c, "head")?;
    let base = commit_param(c, "base")?;
    let (on_branch, truncated) = if branch.is_some() || head.is_some() {
        let found = range(db, branch.as_deref(), head, base)?;
        (Some(found.commits), found.truncated)
    } else if base.is_some() {
        return Err(bad("base needs ref or head"));
    } else {
        (None, false)
    };
    let limit = limit(c);
    let mut cursor = before(c)?;
    let mut sessions = Vec::new();
    let mut more = false;
    // Branch filtering happens here rather than in SQL, so read in pages until full.
    'pages: loop {
        let rows = db.query(
            &format!(
                "SELECT {SESSION_COLUMNS} FROM sessions s JOIN commits c ON c.id=s.commit_id \
                 WHERE s.id<? AND (? IS NULL OR s.cli=?) AND (? IS NULL OR s.model=?) \
                 AND (? IS NULL OR s.session_id=?) ORDER BY s.id DESC LIMIT 200"
            ),
            &[
                json!(cursor),
                json!(cli),
                json!(cli),
                json!(model),
                json!(model),
                json!(session_id),
                json!(session_id),
            ],
        )?;
        let Some(last) = rows.last() else { break };
        cursor = last["id"].as_i64().ok_or_else(|| corrupt("session id"))?;
        let page = rows.len();
        for row in rows {
            let keep = on_branch
                .as_ref()
                .is_none_or(|set| set.contains(row["commit_id"].as_str().unwrap_or_default()));
            if !keep {
                continue;
            }
            if sessions.len() as u64 >= limit {
                more = true;
                break 'pages;
            }
            sessions.push(session(&row)?);
        }
        if page < 200 {
            break;
        }
    }
    let distinct = |column: &str| -> Result<Vec<Value>> {
        Ok(db
            .query(
                &format!("SELECT DISTINCT {column} AS v FROM sessions WHERE {column} IS NOT NULL ORDER BY v LIMIT 100"),
                &[],
            )?
            .into_iter()
            .map(|r| r["v"].clone())
            // The Model filter offers real models only (no "none" from before real_model).
            .filter(|v| column != "model" || !super::sessions::shown_model(v).is_null())
            .collect())
    };
    let next = more
        .then(|| sessions.last().map(|s| s["id"].clone()))
        .flatten();
    super::quarantine::mask_sessions(db, &mut sessions)?;
    Ok(json!({
        "sessions": sessions, "next": next, "clis": distinct("cli")?, "models": distinct("model")?,
        "ref": branch, "head": head, "base": base, "branch_scan_truncated": truncated,
    }))
}

/// `repo_session_show`: `{id}`. One record, its commit, the commit's declared reads and the
/// other records of the same session: by its session id when it has one, else sharing a
/// transcript reference or a prompt digest (records from before session ids).
pub fn session_show<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let id = c["id"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| bad("id must be a session id"))?;
    let row = db
        .query(
            &format!(
                "SELECT {SESSION_COLUMNS},c.principal,c.parents FROM sessions s \
                 JOIN commits c ON c.id=s.commit_id WHERE s.id=?"
            ),
            &[json!(id)],
        )?
        .into_iter()
        .next()
        .ok_or_else(|| Error::new("NOT_FOUND", format!("Session {id} is not recorded")))?;
    let reads: Vec<String> = serde_json::from_str(row["read_set"].as_str().unwrap_or("[]"))
        .map_err(|_| corrupt("read set"))?;
    let related = db.query(
        &format!(
            "SELECT {SESSION_COLUMNS} FROM sessions s JOIN commits c ON c.id=s.commit_id \
             WHERE s.id<>? AND CASE WHEN ? IS NOT NULL THEN s.session_id=? \
             ELSE ((? IS NOT NULL AND s.transcript_ref=?) \
             OR (? IS NOT NULL AND s.prompt_digest=?)) END ORDER BY s.id LIMIT 100"
        ),
        &[
            json!(id),
            row["session_id"].clone(),
            row["session_id"].clone(),
            row["transcript_ref"].clone(),
            row["transcript_ref"].clone(),
            row["prompt_digest"].clone(),
            row["prompt_digest"].clone(),
        ],
    )?;
    let parents: Vec<String> = serde_json::from_str(row["parents"].as_str().unwrap_or("[]"))
        .map_err(|_| corrupt("parents"))?;
    let mut shown = [session(&row)?];
    super::quarantine::mask_sessions(db, &mut shown)?;
    let mut related = related.iter().map(session).collect::<Result<Vec<_>>>()?;
    super::quarantine::mask_sessions(db, &mut related)?;
    let [shown] = shown;
    Ok(json!({
        "session": shown,
        "commit": { "id": row["commit_id"], "message": row["message"],
                    "principal": row["principal"], "parents": parents },
        "reads": reads.iter().take(MAX_READS).collect::<Vec<_>>(),
        "reads_truncated": reads.len() > MAX_READS,
        "related": related,
    }))
}

/// `repo_contract_list`: `{before?, limit?}`. Authored contract records newest first.
pub fn contract_list<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let limit = limit(c);
    let rows = db.query(
        "SELECT seq,path,symbol_path,commit_id,node_digest,contract,recorded_by,recorded_at,\
         recorded_version FROM symbol_contracts WHERE seq<? ORDER BY seq DESC LIMIT ?",
        &[json!(before(c)?), json!(limit + 1)],
    )?;
    let more = rows.len() as u64 > limit;
    let mut records = Vec::new();
    for row in rows.into_iter().take(limit as usize) {
        let contract: Value = serde_json::from_str(row["contract"].as_str().unwrap_or_default())
            .map_err(|_| corrupt("contract record"))?;
        records.push(json!({ "seq": row["seq"], "path": row["path"],
            "symbol_path": row["symbol_path"], "commit": row["commit_id"],
            "node_digest": row["node_digest"], "contract": contract,
            "recorded_by": row["recorded_by"], "recorded_at": row["recorded_at"],
            "recorded_version": row["recorded_version"] }));
    }
    let next = more
        .then(|| records.last().map(|r| r["seq"].clone()))
        .flatten();
    Ok(json!({ "records": records, "next": next }))
}

/// `repo_pin_list`: every pinned commit (pins are few: each holds objects from vacuum).
pub fn pin_list<S: SqlStore>(db: &S, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let pins = db.query(
        "SELECT p.commit_id AS commit_id,p.reason,p.pinned_by,p.pinned_at,c.message \
         FROM pins p LEFT JOIN commits c ON c.id=p.commit_id ORDER BY p.pinned_at DESC LIMIT 500",
        &[],
    )?;
    let pins: Vec<Value> = pins
        .iter()
        .map(|p| {
            json!({ "commit": p["commit_id"], "reason": p["reason"], "pinned_by": p["pinned_by"],
                    "pinned_at": p["pinned_at"], "subject": subject(&p["message"]) })
        })
        .collect();
    Ok(json!({ "pins": pins }))
}

/// `repo_bisect_list`: `{limit?}`. Bisects newest first with their progress.
pub fn bisect_list<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let rows = db.query(
        "SELECT id,refname,check_name,candidates,lo,hi,status,result,requested_by,created_at \
         FROM bisects ORDER BY created_at DESC, id LIMIT ?",
        &[json!(limit(c))],
    )?;
    let mut bisects = Vec::new();
    for row in rows {
        let candidates: Vec<String> =
            serde_json::from_str(row["candidates"].as_str().unwrap_or("[]"))
                .map_err(|_| corrupt("bisect"))?;
        let (lo, hi) = (
            row["lo"].as_u64().unwrap_or(0) as usize,
            row["hi"].as_u64().unwrap_or(0) as usize,
        );
        let result: Value = match row["result"].as_str() {
            Some(text) => serde_json::from_str(text).map_err(|_| corrupt("bisect result"))?,
            None => Value::Null,
        };
        let running = row["status"] == "running";
        bisects.push(json!({
            "id": row["id"], "ref": row["refname"], "check": row["check_name"],
            "status": row["status"], "result": result, "requested_by": row["requested_by"],
            "created_at": row["created_at"], "candidates": candidates.len(),
            "bad": candidates.last(),
            "testing": if running { candidates.get((lo + hi) / 2) } else { None },
            "remaining": if running { hi.saturating_sub(lo) + 1 } else { 0 },
        }));
    }
    Ok(json!({ "bisects": bisects }))
}
