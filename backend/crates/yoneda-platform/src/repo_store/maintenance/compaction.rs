//! Log compaction: keeps the SQL log a bounded tail by moving whole segments of old
//! versions to the object store. The adapter runs it as the vacuum runs: `plan` seals the
//! next segment due, the adapter writes both objects and reads them back, and `done`
//! rebuilds the same segment from the rows it still holds, requires the same fingerprints,
//! and only then deletes those rows and advances the anchor, in this one transaction. A
//! rerun after a crash at any step plans the same bytes again, and a repeated `done` is a
//! no-op, so no entry is lost or archived twice.
use super::super::{hook_events, projection_plan, rows};
use super::archive;
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

const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Defaults: entries leave once they are 10,000 versions behind the head or 30 days old,
/// whichever comes first, so the tail holds at most `keep_versions + SEGMENT_VERSIONS`.
const DEFAULT_KEEP_VERSIONS: u64 = 10_000;
const DEFAULT_KEEP_DAYS: i64 = 30;
const MIN_KEEP_VERSIONS: u64 = 64;
const MAX_KEEP_DAYS: i64 = 3_650;

struct Retention {
    keep_versions: u64,
    keep_ms: i64,
}

impl Retention {
    fn of<S: SqlStore>(db: &S) -> Result<Self> {
        let row = db
            .query(
                "SELECT keep_versions,keep_ms FROM txlog_retention WHERE id=1",
                &[],
            )?
            .into_iter()
            .next();
        Ok(Self {
            keep_versions: row
                .as_ref()
                .and_then(|r| r["keep_versions"].as_u64())
                .unwrap_or(DEFAULT_KEEP_VERSIONS),
            keep_ms: row
                .as_ref()
                .and_then(|r| r["keep_ms"].as_i64())
                .unwrap_or(DEFAULT_KEEP_DAYS * DAY_MS),
        })
    }

    fn json(&self) -> Value {
        json!({ "keep_versions": self.keep_versions, "keep_days": self.keep_ms / DAY_MS })
    }
}

/// `repo_set_retention` (owner): `keep_versions` (at least 64) and/or `keep_days` (1-3650).
pub fn set_retention<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut retention = Retention::of(db)?;
    let field = |key: &str| c.get(key).filter(|v| !v.is_null());
    if field("keep_versions").is_none() && field("keep_days").is_none() {
        return Err(bad("Give keep_versions and/or keep_days"));
    }
    if let Some(v) = field("keep_versions") {
        retention.keep_versions = v
            .as_u64()
            .filter(|n| (MIN_KEEP_VERSIONS..=1_000_000_000).contains(n))
            .ok_or_else(|| bad("keep_versions must be a whole number of at least 64"))?;
    }
    if let Some(v) = field("keep_days") {
        retention.keep_ms = v
            .as_i64()
            .filter(|n| (1..=MAX_KEEP_DAYS).contains(n))
            .ok_or_else(|| bad("keep_days must be a whole number from 1 to 3650"))?
            * DAY_MS;
    }
    db.query(
        "INSERT INTO txlog_retention(id,keep_versions,keep_ms) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET keep_versions=excluded.keep_versions,keep_ms=excluded.keep_ms",
        &[json!(retention.keep_versions), json!(retention.keep_ms)],
    )?;
    Ok(retention.json())
}

/// The next segment due, sealed, with the ref state at its end.
struct Due {
    start: u64,
    end: u64,
    segment: Sealed,
    checkpoints: Sealed,
    end_state: Checkpoint,
}

/// `(start, end]` after the floor, when every reader that streams the log has passed it,
/// it is older than the retention bound, and the head is past it (the head row stays).
fn due<S: SqlStore>(db: &S, c: &Value) -> Result<Option<Due>> {
    let start = archive::floor(db)?;
    let end = start + SEGMENT_VERSIONS;
    let head = rows::current_version(db)?;
    if end >= head || c["hold"].as_u64().is_some_and(|hold| end > hold) {
        return Ok(None);
    }
    let retention = Retention::of(db)?;
    let last = entries(db, end - 1, end)?;
    let old = last
        .first()
        .is_some_and(|e| e.committed_at_ms <= number(c, "now").unwrap_or(0) - retention.keep_ms);
    if !old && end.saturating_add(retention.keep_versions) > head {
        return Ok(None);
    }
    // Changesets not yet projected, and webhook events not yet fanned out, stay in SQL.
    let unprojected = db.query(
        "SELECT MIN(version) AS v FROM changesets WHERE projected IS NULL",
        &[],
    )?[0]["v"]
        .as_u64();
    if unprojected.is_some_and(|v| v <= end)
        || hook_events::held_version(db)?.is_some_and(|v| v < end)
    {
        return Ok(None);
    }
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

/// `repo_compact_plan`: the next segment due (`due` with both sealed objects), or not due.
pub fn plan<S: SqlStore>(db: &S, c: &Value) -> Result<Value> {
    let mut answer = progress(db)?;
    answer["due"] = json!(false);
    if let Some(due) = due(db, c)? {
        answer["due"] = json!(true);
        answer["start"] = json!(due.start);
        answer["end"] = json!(due.end);
        answer["segment"] = json!(due.segment);
        answer["checkpoints"] = json!(due.checkpoints);
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
