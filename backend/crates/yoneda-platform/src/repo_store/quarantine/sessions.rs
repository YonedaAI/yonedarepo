//! Quarantined session records: their text (summary, transcript reference and the stored
//! transcript's metadata) reads masked, the stored transcript document is refused, and a
//! purge clears the text and names the document for the adapter to delete.
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::HashSet;
use yoneda_core::{Error, Result};

/// Session records withheld now (quarantined or purged), by record id.
fn withheld<S: SqlStore>(db: &S) -> Result<HashSet<i64>> {
    Ok(db
        .query(
            "SELECT target_id FROM quarantine WHERE target_kind='session' AND state<>'released'",
            &[],
        )?
        .iter()
        .filter_map(|r| r["target_id"].as_str()?.parse().ok())
        .collect())
}

/// Masks the text of withheld session records among `rows` (session records as the API
/// answers them, by `id`): `summary`, `transcript_ref` and `transcript` read null, and
/// `quarantined` is set.
pub(in crate::repo_store) fn mask_sessions<S: SqlStore>(db: &S, rows: &mut [Value]) -> Result<()> {
    let masked = withheld(db)?;
    if masked.is_empty() {
        return Ok(());
    }
    for row in rows {
        if row["id"].as_i64().is_some_and(|id| masked.contains(&id)) {
            row["summary"] = Value::Null;
            row["transcript_ref"] = Value::Null;
            row["transcript"] = Value::Null;
            row["quarantined"] = json!(true);
        }
    }
    Ok(())
}

/// Refuses the stored transcript of a withheld session record.
pub(in crate::repo_store) fn refuse_transcript<S: SqlStore>(db: &S, id: i64) -> Result<()> {
    if withheld(db)?.contains(&id) {
        return Err(Error::new(
            "QUARANTINED",
            format!("Session {id}'s transcript is quarantined by the repository's owner"),
        ));
    }
    Ok(())
}

/// The sha256 of the transcript document stored for session record `id`, if any: what a
/// purge claim names for the adapter to delete.
pub(super) fn transcript_sha256<S: SqlStore>(db: &S, id: &str) -> Result<Value> {
    let rows = db.query(
        "SELECT transcript FROM sessions WHERE id=?",
        &[json!(id.parse::<i64>().ok())],
    )?;
    let meta = match rows.first() {
        Some(row) => crate::repo_store::sessions::stored_transcript(&row["transcript"])?,
        None => Value::Null,
    };
    Ok(meta["sha256"].clone())
}

/// Clears session record `id`'s text: the purge of a session target.
pub(super) fn clear<S: SqlStore>(db: &S, id: &str) -> Result<()> {
    db.query(
        "UPDATE sessions SET summary='',transcript_ref=NULL,transcript=NULL WHERE id=?",
        &[json!(id.parse::<i64>().ok())],
    )?;
    Ok(())
}
