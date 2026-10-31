//! `repo_ctc_radar {limit?}`: what CTC sees. Every open Landing shown (the newest `limit`, and
//! always those in line), with the decision the job would make as things stand (read here,
//! never recorded), what it waits for, its place in line, what it overlaps and the last decision
//! recorded on it. The line runs queued, then cleared (oldest cleared first), then waiting
//! (oldest Landing first); a Landing going around has to answer first, so it has no place.
//!
//! A radar costs one decision per Landing shown, plus one footprint read for all of them: the
//! page polls it, so `MAX` bounds both. A Landing that can't be judged shows why, not a failure.
use super::super::auth::Actor;
use super::super::changes::{self, whole_repository};
use super::super::land_when_cleared;
use super::super::rows::Settings;
use super::overlaps::{RadarOverlap, overlaps};
use super::{Queue, Seed, read};
use crate::platform_ctc::{Decision, Reason};
use crate::storage::{SqlStore, bad, number};
use schemars::JsonSchema;
use serde::Serialize;
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

const DEFAULT_LIMIT: u64 = 25;
const MAX: u64 = 50;

/// What CTC sees (`GET /ctc`).
#[derive(Debug, Serialize, JsonSchema)]
pub struct CtcRadar {
    /// The repository's switch: with it off the state is what CTC would say, and nothing lands.
    pub land_when_cleared: bool,
    /// In line first, then the rest, newest first.
    pub landings: Vec<RadarLanding>,
    /// There are more open Landings than these.
    pub truncated: bool,
}

/// One open Landing.
#[derive(Debug, Serialize, JsonSchema)]
pub struct RadarLanding {
    pub number: i64,
    pub title: String,
    pub branch: String,
    pub base: String,
    pub author: String,
    /// Null once its branch is gone.
    pub head: Option<String>,
    /// Null when there is nothing to decide on.
    pub decision: Option<Decision>,
    /// What it waits for, or why it goes around.
    pub reasons: Vec<Reason>,
    pub place: Option<RadarPlace>,
    pub overlaps: Vec<RadarOverlap>,
    pub last: Option<RadarDecision>,
}

/// Its place in line.
#[derive(Debug, Serialize, JsonSchema)]
pub struct RadarPlace {
    /// From 1.
    pub position: u64,
    pub line: RadarLine,
    pub ticket: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RadarLine {
    /// Holds a pending landing ticket.
    Queued,
    Cleared,
    Waiting,
}

/// The newest decision recorded on it.
#[derive(Debug, Serialize, JsonSchema)]
pub struct RadarDecision {
    pub decision: Decision,
    /// Its first reason.
    pub reason: Option<String>,
    pub at: i64,
    /// It was about the current head.
    pub on_head: bool,
    pub landed_version: Option<u64>,
}

fn last_decision(change: &Value) -> Option<RadarDecision> {
    let newest = change["clearances"].get(0)?;
    Some(RadarDecision {
        decision: serde_json::from_value(newest["decision"].clone()).ok()?,
        reason: newest["reasons"][0]["reason"].as_str().map(str::to_owned),
        at: newest["at"].as_i64().unwrap_or_default(),
        on_head: !change["head"].is_null() && newest["head"] == change["head"],
        landed_version: newest["landed_version"].as_u64(),
    })
}

fn text(change: &Value, key: &str) -> String {
    change[key].as_str().unwrap_or_default().to_owned()
}

/// The decision on `change`; one that can't be read says why, and leaves the rest standing.
fn decided<S: SqlStore>(
    db: &S,
    change: &Value,
    settings: &Settings,
    queue: &Queue,
) -> (Option<Decision>, Vec<Reason>) {
    let reason = |e: Error| Reason {
        code: e.code,
        reason: e.message,
    };
    match land_when_cleared::decided_on(db, change, settings, queue) {
        Ok(Some((decision, reasons))) => (Some(decision), reasons),
        Ok(None) => {
            let why = format!("The branch {} no longer exists", text(change, "branch"));
            let gone = Reason {
                code: "NO_BRANCH".to_owned(),
                reason: why,
            };
            (None, vec![gone])
        }
        Err(error) => (None, vec![reason(error)]),
    }
}

/// The Landings to show: the newest open, then those in line that are older.
fn shown<S: SqlStore>(db: &S, queue: &Queue, limit: u64) -> Result<(Vec<Value>, bool)> {
    let mut rows = changes::newest_open(db, limit + 1)?;
    let truncated = rows.len() as u64 > limit;
    rows.truncate(limit as usize);
    for place in queue.places() {
        if !rows.iter().any(|row| row["number"] == place.number) {
            rows.push(changes::get(db, place.number)?);
        }
    }
    Ok((rows, truncated))
}

/// Sorts `landings` in line and gives each its place: those `queue` holds, in its order, then any
/// other that is cleared, then those waiting, oldest first.
fn in_line(landings: &mut [RadarLanding], queue: &Queue) {
    let spot = |number: i64| queue.places().iter().position(|p| p.number == number);
    let rank = |l: &RadarLanding| match (spot(l.number), l.decision) {
        (Some(at), _) => (0, at as i64),
        (None, Some(Decision::Cleared)) => (1, l.number),
        (None, Some(Decision::Hold)) => (2, l.number),
        _ => (3, -l.number),
    };
    landings.sort_by_key(rank);
    for (at, landing) in landings.iter_mut().enumerate() {
        let held = spot(landing.number).map(|at| &queue.places()[at]);
        let line = match (held, landing.decision) {
            (Some(place), _) if place.ticket.is_some() => RadarLine::Queued,
            (Some(_), _) | (None, Some(Decision::Cleared)) => RadarLine::Cleared,
            (None, Some(Decision::Hold)) => RadarLine::Waiting,
            _ => continue,
        };
        landing.place = Some(RadarPlace {
            position: at as u64 + 1,
            line,
            ticket: held.and_then(|place| place.ticket),
        });
    }
}

pub fn radar<S: SqlStore>(db: &S, c: &Value, actor: &Actor, settings: &Settings) -> Result<Value> {
    whole_repository(actor)?;
    let limit = match &c["limit"] {
        Value::Null => DEFAULT_LIMIT,
        v => (v.as_u64().filter(|n| (1..=MAX).contains(n)))
            .ok_or_else(|| bad(&format!("limit must be 1-{MAX}")))?,
    };
    let queue = Queue::read(db, settings, number(c, "now")?)?;
    let (rows, truncated) = shown(db, &queue, limit)?;
    let seeds: Vec<Seed> = (rows.iter())
        .filter_map(|row| {
            Some(Seed {
                landing: row["number"].as_i64()?,
                head: row["head"].as_str()?.to_owned(),
                base: format!("refs/heads/{}", row["base"].as_str()?),
            })
        })
        .collect();
    let mut overlaps = overlaps(&read(db, &seeds, None)?);
    let mut landings: Vec<RadarLanding> = rows
        .iter()
        .map(|row| {
            let number = row["number"].as_i64().unwrap_or_default();
            let (decision, reasons) = decided(db, row, settings, &queue);
            RadarLanding {
                number,
                title: text(row, "title"),
                branch: text(row, "branch"),
                base: text(row, "base"),
                author: text(row, "author"),
                head: row["head"].as_str().map(str::to_owned),
                decision,
                reasons,
                place: None,
                overlaps: overlaps.remove(&number).unwrap_or_default(),
                last: last_decision(row),
            }
        })
        .collect();
    in_line(&mut landings, &queue);
    let radar = CtcRadar {
        land_when_cleared: settings.auto_landings.land_when_cleared,
        landings,
        truncated,
    };
    Ok(json!(radar))
}
