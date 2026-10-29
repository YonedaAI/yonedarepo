//! Webhook events for change requests (`change` subscriptions): `change.opened` (opened or
//! reopened), `change.commented`, `change.closed` and `change.deleted` are queued as they happen, like check
//! results; `change.landed` is fanned out with the landing's log version, right after its
//! `land` event. Payloads carry identifiers, refs and times; the title, body or comment text
//! goes in `message`, which only hooks without a path grant receive.
use super::hook_events::{Event, enqueue};
use super::hooks::{self, Hook};
use crate::storage::SqlStore;
use serde_json::{Map, Value, json};
use yoneda_core::{Result, txlog::TxEntry};

const MAX_MESSAGE: usize = 4096;

/// Change text never reaches a path-restricted hook: no grant covers this path.
const WHOLE_REPOSITORY: &str = "";

fn capped(text: &str) -> String {
    let mut end = text.len().min(MAX_MESSAGE);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

fn event(name: &'static str, action: &str, change: &Value, actor: &str, at_ms: i64) -> Event {
    let mut fields = Map::new();
    let refname = format!(
        "refs/heads/{}",
        change["branch"].as_str().unwrap_or_default()
    );
    for (key, value) in [
        ("ref", json!(refname)),
        ("version", change["landed_version"].clone()),
        ("commit", change["head"].clone()),
        ("actor", json!(actor)),
        ("action", json!(action)),
        (
            "change",
            json!({ "number": change["number"], "branch": change["branch"], "base": change["base"],
                    "status": change["status"], "author": change["author"] }),
        ),
    ] {
        fields.insert(key.into(), value);
    }
    let title = change["title"].as_str().unwrap_or_default();
    Event {
        name,
        version: None,
        at_ms,
        fields,
        paths: vec![WHOLE_REPOSITORY.to_owned()],
        message: Some(capped(title)),
    }
}

/// Queues a change event (or, with `comment`, a `change.commented`) for every active hook
/// subscribed to `change`.
pub(super) fn notify<S: SqlStore>(
    db: &S,
    name: &'static str,
    action: &str,
    change: &Value,
    comment: Option<&Value>,
    actor: &str,
    now: i64,
) -> Result<()> {
    let subscribed: Vec<Hook> = hooks::active(db)?
        .into_iter()
        .filter(|h| h.wants(name))
        .collect();
    if subscribed.is_empty() {
        return Ok(());
    }
    let mut event = event(name, action, change, actor, now);
    if name == "change.opened" {
        let body = change["body"].as_str().unwrap_or_default();
        if !body.is_empty() {
            let title = event.message.take().unwrap_or_default();
            event.message = Some(capped(&format!("{title}\n\n{body}")));
        }
    }
    if let Some(comment) = comment {
        event.fields.insert(
            "comment".into(),
            json!({ "id": comment["id"], "commit": comment["commit"], "path": comment["path"],
                    "line": comment["line"], "side": comment["side"] }),
        );
        event.message = comment["body"].as_str().map(capped);
    }
    for hook in &subscribed {
        enqueue(db, hook, &event)?;
    }
    Ok(())
}

/// `change.landed` for each change the landing at `entry` landed, in log order.
pub(super) fn landed<S: SqlStore>(db: &S, entry: &TxEntry) -> Result<Vec<Event>> {
    let mut events = Vec::new();
    for row in db.query(
        "SELECT number FROM changes WHERE landed_version=? ORDER BY number",
        &[json!(entry.version)],
    )? {
        let change = super::changes::get(db, row["number"].as_i64().unwrap_or_default())?;
        let mut landed = event(
            "change.landed",
            "landed",
            &change,
            &entry.actor,
            entry.committed_at_ms,
        );
        landed.version = Some(entry.version);
        events.push(landed);
    }
    Ok(events)
}
