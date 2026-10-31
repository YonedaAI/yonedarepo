//! Log compaction: keeps the SQL log a bounded tail by moving whole segments of old
//! versions to the object store. The adapter runs it as the vacuum runs: `plan` seals the
//! next segment due, the adapter writes both objects and reads them back, and `done`
//! rebuilds the same segment from the rows it still holds, requires the same fingerprints,
//! and only then deletes those rows and advances the anchor, in this one transaction. A
//! rerun after a crash at any step plans the same bytes again, and a repeated `done` is a
//! no-op, so no entry is lost or archived twice.
use super::super::{hook_events, projection_plan, rows};
use super::archive;
use super::retention::{DAY_MS, Retention};
use crate::storage::{SqlStore, bad, number, string};
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    txlog::{
        Checkpoint, TxEntry,
        archive::{SEGMENT_VERSIONS, Sealed, Segment, SegmentCheckpoints, StoredCheckpoint},
        replay_projected,
    },
};

/// How far behind the head a reader's `hold` keeps a due segment in SQL. Past this the
/// segment moves anyway and the plan says `hold_released`: analytics never bounds a
/// repository's log, so a stalled stream costs at most this many extra rows, and a gap.
const MAX_HOLD_VERSIONS: u64 = 16 * SEGMENT_VERSIONS;
/// How far past due a held segment counts as stalled, and the adapter raises the alarm.
const STALL_VERSIONS: u64 = 8 * SEGMENT_VERSIONS;
const STALL_MS: i64 = DAY_MS;

/// The next segment due, sealed, with the ref state at its end.
struct Due {
    start: u64,
    end: u64,
    segment: Sealed,
    checkpoints: Sealed,
    end_state: Checkpoint,
    /// The caller's `hold` would have kept this segment and is past `MAX_HOLD_VERSIONS`.
    hold_released: bool,
}

/// The next segment, once retention lets it leave. Whether it may leave yet is `holder`'s.
struct Ripe {
    start: u64,
    end: u64,
    head: u64,
    retention: Retention,
    /// When its newest entry was committed.
    newest_ms: Option<i64>,
}

/// `(start, end]` after the floor, when it is older than the retention bound and the head is
/// past it (the head row stays).
fn ripe<S: SqlStore>(db: &S, c: &Value) -> Result<Option<Ripe>> {
    let start = archive::floor(db)?;
    let end = start + SEGMENT_VERSIONS;
    let head = rows::current_version(db)?;
    if end >= head {
        return Ok(None);
    }
    let retention = Retention::of(db)?;
    let newest_ms = entries(db, end - 1, end)?
        .first()
        .map(|e| e.committed_at_ms);
    let old = newest_ms.is_some_and(|at| at <= number(c, "now").unwrap_or(0) - retention.keep_ms);
    if !old && end.saturating_add(retention.keep_versions) > head {
        return Ok(None);
    }
    Ok(Some(Ripe {
        start,
        end,
        head,
        retention,
        newest_ms,
    }))
}

/// A caller's `hold` that would keep this segment, and whether it is past `MAX_HOLD_VERSIONS`.
fn read_hold(c: &Value, ripe: &Ripe) -> (bool, bool) {
    let hold = c["hold"].as_u64().filter(|hold| ripe.end > *hold);
    let released = hold.is_some_and(|hold| ripe.head.saturating_sub(hold) > MAX_HOLD_VERSIONS);
    (hold.is_some(), released)
}

/// What keeps a ripe segment in SQL: a reader that streams the log and has not passed it
/// (only to `MAX_HOLD_VERSIONS`), changesets not yet projected, or webhook events not yet
/// fanned out. The last two have no limit.
fn holder<S: SqlStore>(db: &S, c: &Value, ripe: &Ripe) -> Result<Option<&'static str>> {
    if let (true, false) = read_hold(c, ripe) {
        return Ok(Some("changelog"));
    }
    let unprojected = db.query(
        "SELECT MIN(version) AS v FROM changesets WHERE projected IS NULL",
        &[],
    )?[0]["v"]
        .as_u64();
    Ok(if unprojected.is_some_and(|v| v <= ripe.end) {
        Some("unprojected")
    } else if hook_events::held_version(db)?.is_some_and(|v| v < ripe.end) {
        Some("hooks")
    } else {
        None
    })
}

/// The hold on a segment that retention lets leave: `stalled` once it is `STALL_VERSIONS`
/// past the bound or `STALL_MS` past its age, which no passing backlog reaches.
fn held<S: SqlStore>(db: &S, c: &Value) -> Result<Option<Value>> {
    let Some(ripe) = ripe(db, c)? else {
        return Ok(None);
    };
    let Some(by) = holder(db, c, &ripe)? else {
        return Ok(None);
    };
    let bound = ripe.end.saturating_add(ripe.retention.keep_versions);
    let overdue_versions = ripe.head.saturating_sub(bound);
    let age_bound = number(c, "now").unwrap_or(0) - ripe.retention.keep_ms;
    let overdue_ms = ripe.newest_ms.map_or(0, |at| (age_bound - at).max(0));
    Ok(Some(json!({
        "by": by,
        "overdue_versions": overdue_versions,
        "overdue_ms": overdue_ms,
        "stalled": overdue_versions >= STALL_VERSIONS || overdue_ms >= STALL_MS,
    })))
}

/// The next segment that may leave, sealed.
fn due<S: SqlStore>(db: &S, c: &Value) -> Result<Option<Due>> {
    let Some(ripe) = ripe(db, c)? else {
        return Ok(None);
    };
    if holder(db, c, &ripe)?.is_some() {
        return Ok(None);
    }
    let Ripe { start, end, .. } = ripe;
    let base = match archive::anchor(db)? {
        Some(anchor) => anchor,
        None if start == 0 => Checkpoint::default(),
        None => {
            return Err(Error::new(
                "TXLOG_INVALID",
                "The compaction anchor is missing",
            ));
        }
    };
    let run = entries(db, start, end)?;
    let projected = projection_plan::projected_between(db, start, end)?;
    let end_state = replay_projected(&base, &run, &projected)?;
    Ok(Some(Due {
        start,
        end,
        segment: Segment::seal(start, end, run)?,
        checkpoints: SegmentCheckpoints::seal(start, end, base, stored(db, start, end)?)?,
        end_state,
        hold_released: read_hold(c, &ripe).1,
    }))
}

/// The log rows `(after, until]`, read directly: these are exactly the rows that move.
fn entries<S: SqlStore>(db: &S, after: u64, until: u64) -> Result<Vec<TxEntry>> {
    db.query(
        "SELECT entry FROM txlog WHERE version>? AND version<=? ORDER BY version",
        &[json!(after), json!(until)],
    )?
    .iter()
    .map(|row| {
        serde_json::from_str(row["entry"].as_str().unwrap_or_default())
            .map_err(|_| rows::corrupt("log entry"))
    })
    .collect()
}

fn stored<S: SqlStore>(db: &S, start: u64, end: u64) -> Result<Vec<StoredCheckpoint>> {
    db.query(
        "SELECT checkpoint,refs_digest FROM txlog_checkpoints WHERE version>? AND version<=? ORDER BY version",
        &[json!(start), json!(end)],
    )?
    .iter()
    .map(|row| {
        Ok(StoredCheckpoint {
            checkpoint: serde_json::from_str(row["checkpoint"].as_str().unwrap_or_default())
                .map_err(|_| rows::corrupt("checkpoint"))?,
            refs_digest: row["refs_digest"].as_str().map(str::to_owned),
        })
    })
    .collect()
}

fn progress<S: SqlStore>(db: &S) -> Result<Value> {
    Ok(json!({
        "floor": archive::floor(db)?,
        "head": rows::current_version(db)?,
        "tail_rows": db.query("SELECT COUNT(*) AS n FROM txlog", &[])?[0]["n"],
        "retention": Retention::of(db)?.json(),
    }))
}

/// `repo_compact_status`: the floor, the tail and any hold on them. Nothing is sealed, unlike
/// a plan, so it is cheap enough to read while a repository is busy.
pub fn status<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut answer = progress(db)?;
    if let Some(held) = held(db, c)? {
        answer["held"] = held;
    }
    Ok(answer)
}

/// `repo_compact_plan`: the next segment due (`due` with both sealed objects), or not due
/// and, if only a hold stops it, what holds it (`held`).
pub fn plan<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut answer = progress(db)?;
    answer["due"] = json!(false);
    if let Some(due) = due(db, c)? {
        answer["due"] = json!(true);
        answer["start"] = json!(due.start);
        answer["end"] = json!(due.end);
        answer["segment"] = json!(due.segment);
        answer["checkpoints"] = json!(due.checkpoints);
        if due.hold_released {
            answer["hold_released"] = json!(true);
        }
    } else if let Some(held) = held(db, c)? {
        answer["held"] = held;
    }
    Ok(answer)
}

/// `repo_compact_done`: after the adapter wrote and read back the planned objects, moves
/// their rows out, provided the rows still seal to the digests it wrote.
pub fn done<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let start = c["start"]
        .as_u64()
        .ok_or_else(|| bad("start must be a version"))?;
    let end = c["end"]
        .as_u64()
        .ok_or_else(|| bad("end must be a version"))?;
    let digests = (
        string(c, "segment_digest")?,
        string(c, "checkpoints_digest")?,
    );
    let conflict = |why: &str| Err(Error::new("CONFLICT", why.to_owned()));
    if let Some(row) = archive::segment_row(db, start)? {
        if row.end != end || row.digests() != (digests.0.as_str(), digests.1.as_str()) {
            return conflict("Another segment already archived these versions");
        }
        let mut answer = progress(db)?;
        answer["compacted"] = json!(false);
        return Ok(answer);
    }
    let Some(due) = due(db, c)?.filter(|d| (d.start, d.end) == (start, end)) else {
        return conflict("These versions are not the next segment due");
    };
    if (due.segment.digest.as_str(), due.checkpoints.digest.as_str())
        != (digests.0.as_str(), digests.1.as_str())
    {
        return conflict("The archived objects differ from the log they would replace");
    }
    let range = [json!(start), json!(end)];
    db.query("DELETE FROM txlog WHERE version>? AND version<=?", &range)?;
    db.query(
        "DELETE FROM txlog_checkpoints WHERE version<=?",
        &range[1..],
    )?;
    db.query("DELETE FROM txlog_paths WHERE version<=?", &range[1..])?;
    db.query(
        "INSERT INTO txlog_segments(start_version,end_version,segment_key,segment_digest,checkpoints_key,checkpoints_digest,last_chain,compacted_at) VALUES(?,?,?,?,?,?,?,?)",
        &[
            json!(start),
            json!(end),
            json!(due.segment.key),
            json!(due.segment.digest),
            json!(due.checkpoints.key),
            json!(due.checkpoints.digest),
            json!(due.end_state.chain),
            json!(number(c, "now")?),
        ],
    )?;
    archive::set_anchor(db, &due.end_state)?;
    let mut answer = progress(db)?;
    answer["compacted"] = json!(true);
    Ok(answer)
}
