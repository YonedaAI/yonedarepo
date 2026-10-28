//! Session records ("continuous memory"): which coding session produced a commit. Each
//! names the CLI and model, a summary of at most 4 KiB, digests of the prompts and of the
//! declared reads, and optionally where the transcript is kept (a URL or an opaque id;
//! the platform never stores transcripts), and optionally the coding session's own id
//! (`session_id`), which ties one session's records together across commits. Only the
//! commit's pusher (the principal that
//! recorded it) or the repository owner may post one: anyone else could attribute work
//! to a session that did not do it. A summary holding a credential is refused, as a
//! committed file would be.
use super::auth::Actor;
use super::rows::{self, object_id};
use crate::storage::{SqlStore, bad, number};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub const MAX_SUMMARY: usize = 4 * 1024;
const MAX_PER_COMMIT: usize = 20;
const MAX_REF: usize = 512;
const MAX_MODEL: usize = 128;
const MAX_SESSION_ID: usize = 128;
/// The newest-first listing's page bound.
const MAX_RECENT: u64 = 50;

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

/// `repo_session_record`: `{commit, cli, model?, summary, prompt_digest?, transcript_ref?,
/// read_set_digest?, session_id?}`. The same record posted again answers the first one.
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
    let transcript = optional(c, "transcript_ref", MAX_REF, |s| {
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
    let same = db.query(
        "SELECT id FROM sessions WHERE commit_id=? AND recorded_by=? AND cli=? AND summary=? \
         AND prompt_digest IS ? AND transcript_ref IS ? AND session_id IS ?",
        &[
            json!(id.hex()),
            json!(actor.principal),
            json!(cli),
            json!(summary),
            prompt.clone(),
            transcript.clone(),
            session_id.clone(),
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
    db.query(
        "INSERT INTO sessions(commit_id,cli,model,summary,prompt_digest,transcript_ref,read_set_digest,recorded_by,at,session_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        &[json!(id.hex()), json!(cli), model, json!(summary), prompt, transcript, reads,
          json!(actor.principal), json!(number(c, "now")?), session_id],
    )?;
    let session = db.query("SELECT last_insert_rowid() AS id", &[])?[0]["id"].clone();
    Ok(json!({ "commit": id, "session": session }))
}

/// `repo_sessions`: a commit's session records, oldest first.
pub fn list<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let id = object_id(c, "commit")?;
    rows::recorded(db, &id)?;
    let sessions = db.query(
        "SELECT id,cli,model,summary,prompt_digest,transcript_ref,read_set_digest,recorded_by,at,\
         session_id FROM sessions WHERE commit_id=? ORDER BY id",
        &[json!(id.hex())],
    )?;
    Ok(json!({ "commit": id, "sessions": sessions }))
}

/// `repo_sessions_recent {limit?, before?, session_id?}`: the repository's session records
/// newest first (default 20, at most 50), each with its commit and the commit message's
/// first line; `before` (a record id) pages back, `session_id` keeps one session's records.
/// `next` is the `before` of the following page, absent on the last.
pub fn recent<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    whole_repository(actor)?;
    let limit = match &c["limit"] {
        Value::Null => 20,
        v => v
            .as_u64()
            .filter(|n| (1..=MAX_RECENT).contains(n))
            .ok_or_else(|| bad(&format!("limit must be 1-{MAX_RECENT}")))?,
    };
    let before = match &c["before"] {
        Value::Null => i64::MAX,
        v => v
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or_else(|| bad("before must be a session record id"))?,
    };
    let session_id = optional(c, "session_id", MAX_SESSION_ID, printable)?;
    let mut sessions = db.query(
        "SELECT s.id,s.session_id,s.commit_id AS \"commit\",s.cli,s.model,s.summary,s.transcript_ref,\
         s.read_set_digest,s.recorded_by,s.at,substr(m.message,1,300) AS subject \
         FROM sessions s LEFT JOIN commits m ON m.id=s.commit_id \
         WHERE s.id<? AND (? IS NULL OR s.session_id=?) ORDER BY s.id DESC LIMIT ?",
        &[
            json!(before),
            session_id.clone(),
            session_id,
            json!(limit + 1),
        ],
    )?;
    let more = sessions.len() as u64 > limit;
    sessions.truncate(limit as usize);
    for row in &mut sessions {
        let subject = row["subject"]
            .as_str()
            .and_then(|m| m.lines().next())
            .map(str::to_owned);
        row["subject"] = json!(subject);
    }
    let next = more
        .then(|| sessions.last().map(|r| r["id"].clone()))
        .flatten();
    Ok(json!({ "sessions": sessions, "next": next }))
}
