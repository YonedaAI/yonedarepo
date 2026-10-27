//! Webhooks (B3): per-repository hooks that tell something outside the platform (CI, chat,
//! a waiting agent) what happened. The owner (or a `repo:admin` token) manages them. The
//! adapter generates each signing secret; create returns it once and it is stored only
//! here, where the delivery job reads it to sign. Listings never include it.
use super::auth::Actor;
use super::grants::{self, Grant};
use super::{hook_events, hook_url};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

pub const EVENTS: [&str; 6] = ["land", "merged", "refused", "branch", "tag", "check"];
const MAX_HOOKS: i64 = 20;
/// Delivery attempts kept per hook for `GET /hooks/:id/deliveries`.
pub const LOG_SIZE: i64 = 50;

/// An active hook as fan-out sees it.
pub struct Hook {
    pub id: i64,
    pub repo: String,
    pub events: Vec<String>,
    pub grant: Grant,
    pub since_version: u64,
    pub created_at: i64,
}

impl Hook {
    pub fn wants(&self, event: &str) -> bool {
        self.events.iter().any(|e| e == event)
    }
}

fn parse_events(value: &Value) -> Result<Vec<String>> {
    if value.is_null() {
        return Ok(EVENTS.iter().map(|e| (*e).to_owned()).collect());
    }
    let listed: Vec<String> = serde_json::from_value(value.clone())
        .map_err(|_| bad("events must be a list of event names"))?;
    if listed.is_empty() {
        return Err(bad("A hook needs at least one event"));
    }
    let mut events = Vec::new();
    for event in listed {
        if !EVENTS.contains(&event.as_str()) {
            return Err(bad(&format!(
                "Unknown event {event}; events are {}",
                EVENTS.join(", ")
            )));
        }
        if !events.contains(&event) {
            events.push(event);
        }
    }
    Ok(events)
}

/// `repo_hook_create {url, events?, paths?}` plus the adapter's `_secret`, `_repo` and
/// `_workers_subdomain`. A caller limited to a directory grant gets a hook with that
/// grant; otherwise `paths` may narrow what the hook's payloads reveal.
pub fn create<S: SqlStore>(db: &S, c: &Value, actor: &Actor) -> Result<Value> {
    let url = hook_url::validate(&string(c, "url")?, c["_workers_subdomain"].as_str())?;
    let secret = string(c, "_secret")?;
    if secret.len() < 32 {
        return Err(bad("Hook secret is too short"));
    }
    let repo = string(c, "_repo")?;
    let events = parse_events(&c["events"])?;
    let grant = match &actor.grant {
        Some(_) => actor.grant.clone(),
        None => grants::parse(&c["paths"])?,
    };
    let count = db.query("SELECT COUNT(*) AS n FROM hooks", &[])?[0]["n"]
        .as_i64()
        .unwrap_or(0);
    if count >= MAX_HOOKS {
        return Err(Error::new(
            "LIMIT_EXCEEDED",
            format!("A repository has at most {MAX_HOOKS} hooks"),
        ));
    }
    let now = number(c, "now")?;
    let since = hook_events::start_for_new_hook(db)?;
    let paths = grant
        .as_ref()
        .map(|g| serde_json::to_string(g).map_err(|e| bad(&e.to_string())))
        .transpose()?;
    let events_text = serde_json::to_string(&events).map_err(|e| bad(&e.to_string()))?;
    db.query(
        "INSERT INTO hooks(repo,url,secret,events,paths,since_version,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
        &[json!(repo), json!(url), json!(secret), json!(events_text), json!(paths),
          json!(since), json!(actor.principal), json!(now)],
    )?;
    let id = db.query("SELECT last_insert_rowid() AS id", &[])?[0]["id"].clone();
    Ok(json!({
        "id": id, "url": url, "events": events, "paths": grant, "active": true,
        "since_version": since, "created_at": now,
    }))
}

/// `repo_hooks`: every hook, without secrets.
pub fn list<S: SqlStore>(db: &S) -> Result<Value> {
    let hooks: Vec<Value> = db
        .query(
            "SELECT h.id,h.url,h.events,h.paths,h.active,h.failures,h.created_by,h.created_at,h.disabled_at,\
             (SELECT COUNT(*) FROM hook_outbox o WHERE o.hook_id=h.id) AS pending FROM hooks h ORDER BY h.id",
            &[],
        )?
        .into_iter()
        .map(|mut row| {
            for key in ["events", "paths"] {
                row[key] = row[key]
                    .as_str()
                    .and_then(|text| serde_json::from_str(text).ok())
                    .unwrap_or(Value::Null);
            }
            row["active"] = json!(row["active"] == 1);
            row
        })
        .collect();
    Ok(json!({ "hooks": hooks }))
}

fn hook_id(c: &Value) -> Result<i64> {
    let id = &c["hook_id"];
    id.as_i64()
        .or_else(|| id.as_str().and_then(|s| s.parse().ok()))
        .filter(|id| *id > 0)
        .ok_or_else(|| bad("Missing or invalid hook_id"))
}

pub(super) fn existing<S: SqlStore>(db: &S, c: &Value) -> Result<i64> {
    let id = hook_id(c)?;
    if db
        .query("SELECT id FROM hooks WHERE id=?", &[json!(id)])?
        .is_empty()
    {
        return Err(Error::new("NOT_FOUND", "Unknown hook"));
    }
    Ok(id)
}

/// `repo_hook_delete {hook_id}`: the hook, its undelivered payloads and its log; any
/// delivery job still running for it finds nothing to send.
pub fn delete<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = existing(db, c)?;
    for table in ["hook_outbox", "hook_attempts"] {
        db.query(
            &format!("DELETE FROM {table} WHERE hook_id=?"),
            &[json!(id)],
        )?;
    }
    db.query("DELETE FROM hooks WHERE id=?", &[json!(id)])?;
    Ok(json!({ "id": id, "deleted": true }))
}

/// `repo_hook_deliveries {hook_id}`: the last attempts, newest first.
pub fn deliveries<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let id = existing(db, c)?;
    let attempts: Vec<Value> = db
        .query(
            "SELECT delivery_id,event,attempt,ok,status,ms,error,at FROM hook_attempts WHERE hook_id=? ORDER BY id DESC LIMIT ?",
            &[json!(id), json!(LOG_SIZE)],
        )?
        .into_iter()
        .map(|mut row| {
            row["ok"] = json!(row["ok"] == 1);
            row
        })
        .collect();
    Ok(json!({ "id": id, "deliveries": attempts }))
}

/// Active hooks, for fan-out.
pub(super) fn active<S: SqlStore>(db: &S) -> Result<Vec<Hook>> {
    db.query(
        "SELECT id,repo,events,paths,since_version,created_at FROM hooks WHERE active=1 ORDER BY id",
        &[],
    )?
    .into_iter()
    .map(|row| {
        let corrupt = || super::rows::corrupt("hook");
        Ok(Hook {
            id: row["id"].as_i64().ok_or_else(corrupt)?,
            repo: row["repo"].as_str().ok_or_else(corrupt)?.to_owned(),
            events: serde_json::from_str(row["events"].as_str().unwrap_or_default())
                .map_err(|_| corrupt())?,
            grant: match row["paths"].as_str() {
                Some(paths) => Some(serde_json::from_str(paths).map_err(|_| corrupt())?),
                None => None,
            },
            since_version: row["since_version"].as_u64().unwrap_or_default(),
            created_at: row["created_at"].as_i64().unwrap_or_default(),
        })
    })
    .collect()
}

/// RFC 3339 UTC time for epoch milliseconds (civil-from-days, Howard Hinnant).
pub(super) fn iso(ms: i64) -> String {
    let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, milli) = (
        rem / 3_600_000,
        rem / 60_000 % 60,
        rem / 1000 % 60,
        rem % 1000,
    );
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}
