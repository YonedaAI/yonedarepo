//! `git push origin --delete <branch>`: a branch goes by compare-and-swap on what the listing
//! saw, so one that moved meanwhile stays. The platform refuses a protected branch.
use super::Session;
use super::tags::TAGS;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// The ref update deleting `dst`, or why it can't be deleted.
pub fn update(dst: &str, current: Option<&String>) -> Result<Value, String> {
    if dst.starts_with(TAGS) {
        return Err("tags are immutable and cannot be deleted".to_owned());
    }
    match current {
        Some(current) => Ok(json!({ "ref": dst, "commit": null, "expected": current })),
        None => Err("no such branch on the platform".to_owned()),
    }
}

/// Sends `updates` as one batch, unless this is a dry run; a refusal is every one's.
pub async fn send(
    session: &Session,
    updates: &[Value],
    outcomes: &mut BTreeMap<String, Result<(), String>>,
) {
    if session.options.dry_run || updates.is_empty() {
        return;
    }
    let body = json!({ "updates": updates });
    if let Err(failure) = session.api.post("/refs/batch", &body).await {
        for update in updates {
            let dst = update["ref"].as_str().unwrap_or_default().to_owned();
            outcomes.insert(dst, Err(failure.to_string()));
        }
    }
}
