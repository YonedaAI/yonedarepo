//! Memories under quarantine: a memory from a quarantined session (its session id is that
//! of a withheld session record) or anchored to a withheld blob reads masked (its text null,
//! `quarantined` set), and rankings, the start packet, search and delivery labels leave it
//! out. Purging a session record clears the text of its session's memories, and their
//! full-text rows, in the same transaction.
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::HashSet;
use yoneda_core::Result;

/// What a memory read must not show now.
pub(in crate::repo_store) struct Withheld {
    /// Session ids (`claude-code:…`) of withheld session records.
    sessions: HashSet<String>,
    blobs: HashSet<String>,
}

impl Withheld {
    pub(in crate::repo_store) fn read<S: SqlStore>(db: &S) -> Result<Self> {
        let column = |rows: Vec<Value>, key: &str| -> HashSet<String> {
            rows.iter()
                .filter_map(|r| r[key].as_str().map(str::to_owned))
                .collect()
        };
        Ok(Self {
            sessions: column(
                db.query(
                    "SELECT DISTINCT s.session_id FROM quarantine q JOIN sessions s \
                     ON q.target_kind='session' AND q.state<>'released' \
                     AND s.id=CAST(q.target_id AS INTEGER) WHERE s.session_id IS NOT NULL",
                    &[],
                )?,
                "session_id",
            ),
            blobs: column(
                db.query(
                    "SELECT target_id FROM quarantine WHERE target_kind='blob' AND state<>'released'",
                    &[],
                )?,
                "target_id",
            ),
        })
    }

    /// Whether a memory from `session` with anchors on `blobs` is withheld.
    pub(in crate::repo_store) fn masks<'a>(
        &self,
        session: Option<&str>,
        mut blobs: impl Iterator<Item = &'a str>,
    ) -> bool {
        session.is_some_and(|s| self.sessions.contains(s)) || blobs.any(|b| self.blobs.contains(b))
    }

    /// Masks `memory` (as the API answers it) when it is withheld.
    pub(in crate::repo_store) fn mask(&self, memory: &mut Value) {
        let blobs: Vec<String> = memory["anchors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|a| a["blob"].as_str().map(str::to_owned))
            .collect();
        if self.masks(
            memory["session_id"].as_str(),
            blobs.iter().map(String::as_str),
        ) {
            memory["text"] = Value::Null;
            memory["quarantined"] = json!(true);
        }
    }
}

/// Clears the text of the memories of session record `id`'s session: the purge of a
/// session target.
pub(super) fn clear<S: SqlStore>(db: &S, id: &str) -> Result<()> {
    let record = id.parse::<i64>().ok();
    db.query(
        "DELETE FROM memory_text WHERE rowid IN (SELECT m.id FROM memories m JOIN sessions s \
         ON s.session_id=m.session_id WHERE s.id=?)",
        &[json!(record)],
    )?;
    db.query(
        "UPDATE memories SET body='' WHERE session_id IN \
         (SELECT session_id FROM sessions WHERE id=? AND session_id IS NOT NULL)",
        &[json!(record)],
    )?;
    Ok(())
}
