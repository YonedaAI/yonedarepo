//! Reads across the compaction floor. Versions up to the floor live in sealed segments in
//! the object store; the authority never fetches them (no network I/O here), it names the
//! objects (`TXLOG_ARCHIVED`) and the adapter retries with their text in `_archive`, which
//! is accepted only when it has the fingerprints recorded when the segment moved.
use super::super::rows::corrupt;
use crate::storage::SqlStore;
use serde_json::{Value, json};
use yoneda_core::{
    Error, Result,
    txlog::{
        Checkpoint, TxEntry,
        archive::{Segment, SegmentCheckpoints, state_at as replay_segment},
    },
};

/// One archived run of versions `(start, end]` as recorded when it moved.
pub(super) struct SegmentRow {
    pub start: u64,
    pub end: u64,
    segment_key: String,
    segment_digest: String,
    checkpoints_key: String,
    checkpoints_digest: String,
}

/// The newest archived version (0 while nothing moved).
pub fn floor<S: SqlStore>(db: &S) -> Result<u64> {
    Ok(db
        .query("SELECT version FROM txlog_anchor WHERE id=1", &[])?
        .first()
        .and_then(|row| row["version"].as_u64())
        .unwrap_or(0))
}

/// The ref state at the floor, where replay of the retained tail starts. It must hash to
/// its stored digest and sit on the chain the newest segment ends with.
pub fn anchor<S: SqlStore>(db: &S) -> Result<Option<Checkpoint>> {
    let Some(row) = db
        .query(
            "SELECT a.version,a.checkpoint,a.refs_digest,s.last_chain FROM txlog_anchor a LEFT JOIN txlog_segments s ON s.end_version=a.version WHERE a.id=1",
            &[],
        )?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let checkpoint: Checkpoint =
        serde_json::from_str(row["checkpoint"].as_str().unwrap_or_default())
            .map_err(|_| corrupt("anchor checkpoint"))?;
    if row["version"].as_u64() != Some(checkpoint.version)
        || row["last_chain"].as_str() != Some(checkpoint.chain.as_str())
        || row["refs_digest"].as_str() != Some(checkpoint.refs_digest()?.as_str())
    {
        return Err(Error::new(
            "TXLOG_INVALID",
            "The compaction anchor disagrees with its digest or the archived log",
        ));
    }
    Ok(Some(checkpoint))
}

/// Records `end`'s state as the new anchor; the segment row it chains to is written first.
pub(super) fn set_anchor<S: SqlStore>(db: &S, state: &Checkpoint) -> Result<()> {
    db.query(
        "INSERT INTO txlog_anchor(id,version,checkpoint,refs_digest) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,checkpoint=excluded.checkpoint,refs_digest=excluded.refs_digest",
        &[
            json!(state.version),
            json!(serde_json::to_string(state).map_err(|e| corrupt(&e.to_string()))?),
            json!(state.refs_digest()?),
        ],
    )?;
    Ok(())
}

pub(super) fn segment_row<S: SqlStore>(db: &S, start: u64) -> Result<Option<SegmentRow>> {
    segment_where(db, "start_version=?", start)
}

/// The archived segment holding `version`.
fn holding<S: SqlStore>(db: &S, version: u64) -> Result<SegmentRow> {
    segment_where(db, "start_version<? AND end_version>=?", version)?.ok_or_else(|| {
        Error::new(
            "TXLOG_INVALID",
            format!("No archived segment holds version {version}"),
        )
    })
}

fn segment_where<S: SqlStore>(db: &S, filter: &str, value: u64) -> Result<Option<SegmentRow>> {
    let params = vec![json!(value); filter.matches('?').count()];
    let Some(row) = db
        .query(
            &format!("SELECT * FROM txlog_segments WHERE {filter} LIMIT 1"),
            &params,
        )?
        .into_iter()
        .next()
    else {
        return Ok(None);
    };
    let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
    Ok(Some(SegmentRow {
        start: row["start_version"]
            .as_u64()
            .ok_or_else(|| corrupt("segment"))?,
        end: row["end_version"]
            .as_u64()
            .ok_or_else(|| corrupt("segment"))?,
        segment_key: text("segment_key"),
        segment_digest: text("segment_digest"),
        checkpoints_key: text("checkpoints_key"),
        checkpoints_digest: text("checkpoints_digest"),
    }))
}

impl SegmentRow {
    pub(super) fn digests(&self) -> (&str, &str) {
        (&self.segment_digest, &self.checkpoints_digest)
    }

    /// The segment and its checkpoints from the command's `_archive`, verified against the
    /// recorded fingerprints; without them, the error names the objects to fetch.
    fn open(&self, c: &Value, version: u64) -> Result<(Segment, SegmentCheckpoints)> {
        let Some(archive) = c.get("_archive").filter(|a| a.is_object()) else {
            return Err(Error::new(
                "TXLOG_ARCHIVED",
                format!(
                    "Version {version} is archived in {} and {}",
                    self.segment_key, self.checkpoints_key
                ),
            ));
        };
        let text = |key: &str| {
            archive[key].as_str().ok_or_else(|| {
                Error::new(
                    "ARCHIVE_CORRUPT",
                    format!("Archived {key} for version {version} is missing"),
                )
            })
        };
        Ok((
            Segment::open(text("segment")?, &self.segment_digest, self.start, self.end)?,
            SegmentCheckpoints::open(
                text("checkpoints")?,
                &self.checkpoints_digest,
                self.start,
                self.end,
            )?,
        ))
    }
}

/// The ref state at an archived `version` (`0 < version < floor`).
pub fn state_at<S: SqlStore>(db: &S, c: &Value, version: u64) -> Result<Checkpoint> {
    let row = holding(db, version)?;
    let (segment, checkpoints) = row.open(c, version)?;
    let projected = super::super::projection_plan::projected_between(db, row.start, version)?;
    replay_segment(&segment, &checkpoints, version, &projected)
}

/// Archived entries after `after` (below the floor), up to `limit`, ending at the end of
/// the segment holding `after + 1`: a listing pages through the archive a segment a time.
pub fn page<S: SqlStore>(db: &S, c: &Value, after: u64, limit: u64) -> Result<Vec<TxEntry>> {
    let row = holding(db, after + 1)?;
    let (segment, _) = row.open(c, after + 1)?;
    let until = row.end.min(after.saturating_add(limit));
    Ok(segment.entries[(after - row.start) as usize..(until - row.start) as usize].to_vec())
}
