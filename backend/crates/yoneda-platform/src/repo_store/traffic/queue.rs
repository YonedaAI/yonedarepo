//! The order of Landings, from what is already recorded: `land_queue`'s pending tickets in ticket
//! order, then Landings whose newest decision clears their current head, oldest cleared first.
//! Nothing new schedules anything: this reads the queue that exists, for separation
//! (`ahead_of`) and for the radar. A Landing that is only waiting has no place: it might never
//! clear, and holding anyone behind it would let one abandoned Landing stop a repository.
//!
//! A cleared Landing is on its way to landing, so its place lapses after `CLEARED_HOLDS_MS`: a
//! job that died and lost its last word as well leaves nothing holding anyone forever.
use super::super::rows::Settings;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::Result;

/// Open Landings read, newest first.
const OPEN: u64 = 200;
/// Pending tickets read, oldest first.
const TICKETS: u64 = 64;
const CLEARED_HOLDS_MS: i64 = 10 * 60 * 1000;
const CLEARED: &str = "cleared";

/// One Landing's place in the line.
#[derive(Debug, Clone)]
pub(in crate::repo_store) struct Place {
    pub number: i64,
    pub head: String,
    /// The full ref name of its base.
    pub base: String,
    pub ticket: Option<i64>,
    pub cleared_at: Option<i64>,
}

/// The Landings in line, first to land first.
#[derive(Debug, Default)]
pub(in crate::repo_store) struct Queue {
    places: Vec<Place>,
}

fn open_rows<S: SqlStore>(db: &S, decided: bool) -> Result<Vec<Value>> {
    // `clearance` arrives with `land_when_cleared`, in a migration a store may not have yet.
    let columns = if decided {
        ",json_extract(c.clearance,'$[0].decision') AS decision,\
         json_extract(c.clearance,'$[0].head') AS judged,\
         json_extract(c.clearance,'$[0].at') AS decided_at"
    } else {
        ""
    };
    db.query(
        &format!(
            "SELECT c.number,c.base,r.commit_id AS head{columns} FROM changes c \
             JOIN refs r ON r.name='refs/heads/'||c.branch WHERE c.status='open' \
             ORDER BY c.number DESC LIMIT ?"
        ),
        &[json!(OPEN)],
    )
}

/// `(base, head)` to its ticket, for each pending ticket on `bases`.
fn tickets<S: SqlStore>(db: &S, bases: &[String]) -> Result<BTreeMap<(String, String), i64>> {
    let rows = db.query(
        "SELECT ticket,refname,commit_id FROM land_queue WHERE status='pending' \
         AND refname IN (SELECT value FROM json_each(?)) ORDER BY ticket LIMIT ?",
        &[json!(json!(bases).to_string()), json!(TICKETS)],
    )?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let key = (row["refname"].as_str()?, row["commit_id"].as_str()?);
            Some(((key.0.to_owned(), key.1.to_owned()), row["ticket"].as_i64()?))
        })
        .collect())
}

fn cleared_at(row: &Value, now: i64) -> Option<i64> {
    let at = row["decided_at"].as_i64()?;
    (row["decision"] == CLEARED && row["judged"] == row["head"] && at > now - CLEARED_HOLDS_MS)
        .then_some(at)
}

impl Queue {
    /// With the switch off nothing has cleared, and a person's ticket holds nobody: only the
    /// tickets of open Landings are in line.
    pub fn read<S: SqlStore>(db: &S, settings: &Settings, now: i64) -> Result<Self> {
        let rows = open_rows(db, settings.auto_landings.land_when_cleared)?;
        let mut bases: Vec<String> = (rows.iter())
            .filter_map(|r| r["base"].as_str())
            .map(|base| format!("refs/heads/{base}"))
            .collect();
        bases.sort();
        bases.dedup();
        let tickets = tickets(db, &bases)?;
        let mut places: Vec<Place> = rows
            .iter()
            .filter_map(|row| {
                let head = row["head"].as_str()?.to_owned();
                let base = format!("refs/heads/{}", row["base"].as_str()?);
                let ticket = tickets.get(&(base.clone(), head.clone())).copied();
                let cleared_at = cleared_at(row, now);
                (ticket.is_some() || cleared_at.is_some()).then_some(Place {
                    number: row["number"].as_i64()?,
                    head,
                    base,
                    ticket,
                    cleared_at,
                })
            })
            .collect();
        places.sort_by_key(|p| (p.ticket.is_none(), p.ticket, p.cleared_at, p.number));
        Ok(Self { places })
    }

    pub fn places(&self) -> &[Place] {
        &self.places
    }

    /// Who is ahead of Landing `number` on `base`: everyone in line there, when it isn't.
    pub fn ahead_of(&self, number: i64, base: &str) -> Vec<&Place> {
        (self.places.iter())
            .filter(|p| p.base == base)
            .take_while(|p| p.number != number)
            .collect()
    }
}
