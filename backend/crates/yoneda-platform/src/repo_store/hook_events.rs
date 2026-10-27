//! Webhook events. After landing and off the commit path, the repository's event cursor
//! fans log versions (lands, branch and tag moves), commits a platform merge landed and
//! refused queued landings (the change log's records) out to each subscribed hook's
//! ordered outbox. Check results are queued as they complete. A payload is built once, so
//! every retry sends the same bytes: identifiers, refs, counts and times, never file
//! contents. A commit message is included only when the hook's grant covers every path
//! the commit touched.
use super::hooks::{self, Hook};
use super::{change_records, grants, rows};
use crate::storage::SqlStore;
use serde_json::{Map, Value, json};
use yoneda_core::{
    Result,
    git_object::ObjectId,
    txlog::{TxEntry, TxKind},
};

const MAX_VERSIONS: u64 = 100;
/// A hook this far behind is switched off rather than left to grow without bound.
const MAX_PENDING: i64 = 1000;
const MAX_MESSAGE: usize = 4096;

struct Event {
    name: &'static str,
    /// The log version, for events the log ordered; refusals and checks have none.
    version: Option<u64>,
    at_ms: i64,
    fields: Map<String, Value>,
    /// Paths the commit touched and its message, shown only within a hook's grant.
    paths: Vec<String>,
    message: Option<String>,
}

fn cursor<S: SqlStore>(db: &S) -> Result<Option<(u64, i64)>> {
    Ok(db
        .query("SELECT version,ticket FROM hook_cursor WHERE id=1", &[])?
        .first()
        .map(|r| {
            (
                r["version"].as_u64().unwrap_or_default(),
                r["ticket"].as_i64().unwrap_or_default(),
            )
        }))
}

fn save_cursor<S: SqlStore>(db: &S, version: u64, ticket: i64) -> Result<()> {
    db.query(
        "INSERT INTO hook_cursor(id,version,ticket) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,ticket=excluded.ticket",
        &[json!(version), json!(ticket)],
    )?;
    Ok(())
}

/// The highest ticket below which every queued landing has finished.
fn watermark<S: SqlStore>(db: &S) -> Result<i64> {
    let row = &db.query(
        "SELECT (SELECT MIN(ticket) FROM land_queue WHERE status='pending') AS p, (SELECT COALESCE(MAX(ticket),0) FROM land_queue) AS h",
        &[],
    )?[0];
    let highest = row["h"].as_i64().unwrap_or(0);
    Ok(row["p"].as_i64().map_or(highest, |t| t - 1))
}

/// The version a new hook starts after. With no other active hook nothing needs the
/// cursor's backlog, so it moves to now and the first fan-out has no history to scan.
pub fn start_for_new_hook<S: SqlStore>(db: &S) -> Result<u64> {
    let head = rows::current_version(db)?;
    if hooks::active(db)?.is_empty() {
        save_cursor(db, head, watermark(db)?)?;
    }
    Ok(head)
}

/// `repo_hooks_fanout`: queues every event after the cursor (up to 100 versions) for the
/// hooks that want it and moves the cursor, in one transaction. Answers the hooks with
/// undelivered payloads and whether versions remain.
pub fn fanout<S: SqlStore>(db: &S) -> Result<Value> {
    let hooks = hooks::active(db)?;
    let head = rows::current_version(db)?;
    if hooks.is_empty() {
        save_cursor(db, head, watermark(db)?)?;
        return Ok(json!({ "hooks": [], "more": false }));
    }
    let (after, ticket) = match cursor(db)? {
        Some(at) => at,
        None => (head, watermark(db)?),
    };
    let until = head.min(after.saturating_add(MAX_VERSIONS));
    let mut events = Vec::new();
    for entry in rows::entries(db, after, until, None)? {
        events.extend(entry_events(db, &entry)?);
    }
    let (refused, next_ticket) = change_records::refusals(db, ticket, MAX_VERSIONS)?;
    events.extend(refused.into_iter().map(refusal));
    for hook in &hooks {
        for event in &events {
            let new = match event.version {
                Some(version) => version > hook.since_version,
                None => event.at_ms >= hook.created_at,
            };
            if new && hook.wants(event.name) {
                enqueue(db, hook, event)?;
            }
        }
    }
    save_cursor(db, until, next_ticket)?;
    let pending: Vec<Value> = db
        .query(
            "SELECT DISTINCT o.hook_id AS id FROM hook_outbox o JOIN hooks h ON h.id=o.hook_id WHERE h.active=1 ORDER BY o.hook_id",
            &[],
        )?
        .into_iter()
        .map(|r| r["id"].clone())
        .collect();
    Ok(json!({ "hooks": pending, "more": until < head }))
}

/// Queues a completed check (`pass`, `fail` or `error`) for the hooks that want checks;
/// answers whether any did.
pub fn check<S: SqlStore>(
    db: &S,
    commit: &str,
    name: &str,
    conclusion: &str,
    actor: &str,
    now: i64,
    run_id: Option<&str>,
) -> Result<bool> {
    let hooks: Vec<Hook> = hooks::active(db)?
        .into_iter()
        .filter(|h| h.wants("check"))
        .collect();
    if hooks.is_empty() {
        return Ok(false);
    }
    let id = ObjectId::parse(commit)?;
    let mut fields = Map::new();
    for (key, value) in [
        ("ref", Value::Null),
        ("version", Value::Null),
        ("commit", json!(commit)),
        ("before", Value::Null),
        ("after", Value::Null),
        ("actor", json!(actor)),
        ("name", json!(name)),
        ("conclusion", json!(conclusion)),
        ("run_id", json!(run_id)),
    ] {
        fields.insert(key.into(), value);
    }
    let event = Event {
        name: "check",
        version: None,
        at_ms: now,
        fields,
        paths: rows::touches(db, &id)?
            .into_iter()
            .map(|t| t.path)
            .collect(),
        message: message(db, &id)?,
    };
    for hook in &hooks {
        enqueue(db, hook, &event)?;
    }
    Ok(true)
}

fn enqueue<S: SqlStore>(db: &S, hook: &Hook, event: &Event) -> Result<()> {
    let pending = db.query(
        "SELECT COUNT(*) AS n FROM hook_outbox WHERE hook_id=?",
        &[json!(hook.id)],
    )?[0]["n"]
        .as_i64()
        .unwrap_or(0);
    if pending >= MAX_PENDING {
        db.query(
            "UPDATE hooks SET active=0,disabled_at=? WHERE id=?",
            &[json!(event.at_ms), json!(hook.id)],
        )?;
        return Ok(());
    }
    let mut payload = Map::new();
    payload.insert("event".into(), json!(event.name));
    payload.insert("repo".into(), json!(hook.repo));
    payload.extend(event.fields.clone());
    payload.insert("at".into(), json!(hooks::iso(event.at_ms)));
    if let Some(text) = &event.message
        && event.paths.iter().all(|p| grants::allows(&hook.grant, p))
    {
        payload.insert("message".into(), json!(text));
    }
    db.query(
        "INSERT INTO hook_outbox(hook_id,event,payload) VALUES(?,?,?)",
        &[
            json!(hook.id),
            json!(event.name),
            json!(Value::Object(payload).to_string()),
        ],
    )?;
    Ok(())
}

/// One log version as events: a branch or tag move, or a landing plus a `merged` event per
/// commit a platform merge landed along with it.
fn entry_events<S: SqlStore>(db: &S, entry: &TxEntry) -> Result<Vec<Event>> {
    let base = |name: &'static str, commit: Option<String>| {
        let mut fields = Map::new();
        fields.insert("ref".into(), json!(entry.refname));
        fields.insert("version".into(), json!(entry.version));
        fields.insert("commit".into(), json!(commit));
        fields.insert("before".into(), json!(entry.old));
        fields.insert("after".into(), json!(entry.new));
        fields.insert("actor".into(), json!(entry.actor));
        Event {
            name,
            version: Some(entry.version),
            at_ms: entry.committed_at_ms,
            fields,
            paths: Vec::new(),
            message: None,
        }
    };
    let head = entry.new.map(|id| id.hex());
    if matches!(entry.kind, TxKind::RefMove | TxKind::RefDelete) {
        let tag = rows::is_tag(&entry.refname);
        let mut event = base(if tag { "tag" } else { "branch" }, head);
        let action = match (entry.kind, entry.old) {
            (TxKind::RefDelete, _) => "deleted",
            (_, None) => "created",
            _ => "moved",
        };
        event.fields.insert("action".into(), json!(action));
        return Ok(vec![event]);
    }
    let mut land = base("land", head.clone());
    land.fields.insert("kind".into(), json!(entry.kind));
    land.fields
        .insert("paths_changed".into(), json!(entry.paths.len()));
    land.paths = entry.paths.iter().map(|t| t.path.clone()).collect();
    if let Some(id) = entry.new {
        land.message = message(db, &id)?;
    }
    let mut events = vec![land];
    for row in db.query(
        "SELECT l.commit_id AS id,(SELECT q.principal FROM land_queue q WHERE q.commit_id=l.commit_id AND q.refname=l.refname AND q.status='landed' ORDER BY q.ticket DESC LIMIT 1) AS queued_by \
         FROM landings l WHERE l.version=? ORDER BY l.commit_id",
        &[json!(entry.version)],
    )? {
        let Some(id) = row["id"].as_str().filter(|id| Some(*id) != head.as_deref()) else {
            continue;
        };
        let id = ObjectId::parse(id)?;
        let mut merged = base("merged", Some(id.hex()));
        if let Some(by) = row["queued_by"].as_str() {
            merged.fields.insert("actor".into(), json!(by));
        }
        merged.paths = rows::touches(db, &id)?.into_iter().map(|t| t.path).collect();
        merged.message = message(db, &id)?;
        events.push(merged);
    }
    Ok(events)
}

/// A refused queued landing from the change records.
fn refusal(record: Value) -> Event {
    let mut fields = Map::new();
    for key in ["ref", "commit", "actor", "ticket", "error_code"] {
        fields.insert(key.into(), record[key].clone());
    }
    fields.insert("version".into(), Value::Null);
    fields.insert("before".into(), Value::Null);
    fields.insert("after".into(), Value::Null);
    Event {
        name: "refused",
        version: None,
        at_ms: record["occurred_at_ms"].as_i64().unwrap_or_default(),
        fields,
        paths: Vec::new(),
        message: None,
    }
}

/// The commit's message (capped), from its record or the changeset that landed it.
fn message<S: SqlStore>(db: &S, id: &ObjectId) -> Result<Option<String>> {
    Ok(db
        .query(
            "SELECT message FROM commits WHERE id=?1 UNION ALL SELECT message FROM changesets WHERE commit_id=?1 AND message IS NOT NULL LIMIT 1",
            &[json!(id.hex())],
        )?
        .first()
        .and_then(|r| r["message"].as_str())
        .map(|text| {
            let mut end = text.len().min(MAX_MESSAGE);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            text[..end].to_owned()
        }))
}
