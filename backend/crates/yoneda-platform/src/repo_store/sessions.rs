//! Session records ("continuous memory"): which coding session produced a commit. Each
//! names the CLI and model, a summary of at most 4 KiB, digests of the prompts and of the
//! declared reads, optionally where a transcript is kept (`transcript_ref`, a URL or an
//! opaque id), optionally the transcript the platform stores (`transcript`: its metadata;
//! the adapter redacts and fits the document, `platform_transcript`, and writes it to R2
//! before posting, so a stored transcript fills an absent `transcript_ref`), and optionally
//! the coding session's own id (`session_id`), which ties one session's records together
//! across commits. Only the commit's pusher (the principal that recorded it) or the
//! repository owner may post one: anyone else could attribute work to a session that did
//! not do it. A summary holding a credential is refused, as a committed file would be.
use super::auth::Actor;
use super::rows::{self, object_id};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::transcript::STORED;
use yoneda_core::{Error, Result};

pub const MAX_SUMMARY: usize = 4 * 1024;
const MAX_PER_COMMIT: usize = 20;
const MAX_REF: usize = 512;
const MAX_MODEL: usize = 128;
const MAX_SESSION_ID: usize = 128;

/// Session records read and post whole commits, so a path-restricted token can do neither.
pub fn whole_repository(actor: &Actor) -> Result<()> {
    if actor.grant.is_some() {
        return Err(Error::new(
            "FORBIDDEN",
            "Session records describe whole commits; a path-restricted token cannot use them",
        ));
    }
    Ok(())
}

fn optional(c: &Value, key: &str, max: usize, valid: impl Fn(&str) -> bool) -> Result<Value> {
    match &c[key] {
        Value::Null => Ok(Value::Null),
        Value::String(s) if s.len() <= max && valid(s) => Ok(json!(s)),
        _ => Err(bad(&format!("{key} is invalid (at most {max} characters)"))),
    }
}

fn hex_digest(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn printable(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(char::is_control)
}

/// The stored transcript's metadata as the adapter reports it (`platform_transcript`), in
/// the fixed shape the record keeps; null when none was stored.
fn transcript_meta(c: &Value) -> Result<Value> {
    let meta = &c["transcript"];
    if meta.is_null() {
        return Ok(Value::Null);
    }
    let count = |key: &str, max: u64| meta[key].as_u64().filter(|n| *n <= max);
    let flag = |key: &str| meta[key].as_bool();
    let sha256 = meta["sha256"].as_str().filter(|s| hex_digest(s));
    match (
        sha256,
        count("bytes", (STORED.total + 4096) as u64).filter(|n| *n > 0),
        count("turns", STORED.turns as u64),
        count("redactions", u32::MAX.into()),
        flag("truncated"),
        flag("context"),
    ) {
        (
            Some(sha256),
            Some(bytes),
            Some(turns),
            Some(redactions),
            Some(truncated),
            Some(context),
        ) => Ok(json!({ "sha256": sha256, "bytes": bytes, "turns": turns,
                       "redactions": redactions, "truncated": truncated, "context": context })),
        _ => Err(bad(
            "transcript is the stored document's {sha256, bytes, turns, redactions, truncated, context}",
        )),
    }
}

/// The stored metadata column as JSON.
pub fn stored_transcript(column: &Value) -> Result<Value> {
    match column.as_str() {
        Some(text) => serde_json::from_str(text).map_err(|_| super::rows::corrupt("transcript")),
        None => Ok(Value::Null),
    }
}

/// `repo_session_record`: `{commit, cli, model?, summary, prompt_digest?, transcript_ref?,
/// read_set_digest?, session_id?, transcript?, dry_run?}`. The same record posted again
/// answers the first one; `dry_run` checks a record (or finds it kept) without keeping it.
pub fn record<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let id = object_id(c, "commit")?;
    let commit = rows::recorded(db, &id)?;
    if commit.principal != actor.principal && !actor.owner {
        return Err(Error::new(
            "FORBIDDEN",
            "Only the commit's pusher or the repository owner can record its session",
        ));
    }
    let cli = c["cli"]
        .as_str()
        .filter(|s| {
            (1..=64).contains(&s.len())
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
        .ok_or_else(|| bad("cli must be 1-64 letters, digits, '.', '_' or '-'"))?;
    let summary = c["summary"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= MAX_SUMMARY)
        .ok_or_else(|| bad("summary must be 1-4096 bytes; truncate it before posting"))?;
    let model = optional(c, "model", MAX_MODEL, printable)?;
    let stored = transcript_meta(c)?;
    let mut transcript = optional(c, "transcript_ref", MAX_REF, |s| {
        printable(s) && !s.contains(char::is_whitespace)
    })?;
    let session_id = optional(c, "session_id", MAX_SESSION_ID, |s| {
        printable(s) && !s.contains(char::is_whitespace)
    })?;
    let prompt = optional(c, "prompt_digest", 64, hex_digest)?;
    let reads = optional(c, "read_set_digest", 64, hex_digest)?;
    for (field, text) in [
        ("summary", Some(summary)),
        ("model", model.as_str()),
        ("transcript_ref", transcript.as_str()),
        ("session_id", session_id.as_str()),
    ] {
        if let Some(text) = text {
            crate::secret_scan::scan(&format!("session {field}"), text.as_bytes(), &[])?;
        }
    }
    if transcript.is_null() && !stored.is_null() {
        transcript = json!(format!(
            "transcript:sha256:{}",
            stored["sha256"].as_str().unwrap_or_default()
        ));
    }
    let stored = (!stored.is_null()).then(|| stored.to_string());
    let same = db.query(
        "SELECT id FROM sessions WHERE commit_id=? AND recorded_by=? AND cli=? AND summary=? \
         AND prompt_digest IS ? AND transcript_ref IS ? AND session_id IS ? AND transcript IS ?",
        &[
            json!(id.hex()),
            json!(actor.principal),
            json!(cli),
            json!(summary),
            prompt.clone(),
            transcript.clone(),
            session_id.clone(),
            json!(stored),
        ],
    )?;
    if let Some(row) = same.first() {
        return Ok(json!({ "commit": id, "session": row["id"], "already": true }));
    }
    let held = db.query(
        "SELECT COUNT(*) AS n FROM sessions WHERE commit_id=?",
        &[json!(id.hex())],
    )?;
    if held[0]["n"].as_u64().unwrap_or(0) >= MAX_PER_COMMIT as u64 {
        return Err(Error::new(
            "TOO_LARGE",
            format!("A commit holds at most {MAX_PER_COMMIT} session records"),
        ));
    }
    if c["dry_run"] == true {
        return Ok(json!({ "commit": id, "dry_run": true }));
    }
    db.query(
        "INSERT INTO sessions(commit_id,cli,model,summary,prompt_digest,transcript_ref,read_set_digest,recorded_by,at,session_id,transcript) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        &[json!(id.hex()), json!(cli), model, json!(summary), prompt, transcript, reads,
          json!(actor.principal), json!(number(c, "now")?), session_id, json!(stored)],
    )?;
    let session = db.query("SELECT last_insert_rowid() AS id", &[])?[0]["id"].clone();
    Ok(json!({ "commit": id, "session": session }))
}

/// `repo_sessions`: a commit's session records, oldest first.
pub fn list<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let id = object_id(c, "commit")?;
    rows::recorded(db, &id)?;
    let mut sessions = db.query(
        "SELECT id,cli,model,summary,prompt_digest,transcript_ref,read_set_digest,recorded_by,at,\
         session_id,transcript FROM sessions WHERE commit_id=? ORDER BY id",
        &[json!(id.hex())],
    )?;
    for row in &mut sessions {
        row["transcript"] = stored_transcript(&row["transcript"])?;
    }
    Ok(json!({ "commit": id, "sessions": sessions }))
}

/// `repo_session_transcript`: `{id}`. The metadata of the transcript stored for a session
/// record, which names the R2 document the adapter serves.
pub fn transcript<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let id = c["id"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| bad("id must be a session id"))?;
    let row = db.query("SELECT transcript FROM sessions WHERE id=?", &[json!(id)])?;
    let meta = match row.first() {
        Some(row) => stored_transcript(&row["transcript"])?,
        None => {
            return Err(Error::new(
                "NOT_FOUND",
                format!("Session {id} is not recorded"),
            ));
        }
    };
    if meta.is_null() {
        return Err(Error::new(
            "NOT_FOUND",
            format!("Session {id} has no stored transcript"),
        ));
    }
    Ok(json!({ "session": id, "transcript": meta }))
}
