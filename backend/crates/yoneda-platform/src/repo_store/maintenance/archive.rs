//! The log across the compaction floor. Versions up to the floor live in sealed segments in
//! the object store; the authority never fetches them (no network I/O here). A command that
//! needs them is answered `TXLOG_ARCHIVED` naming the objects, and the adapter sends it
//! again carrying their text (`supplied`), which is accepted only when it has the
//! fingerprints recorded when the segment moved.
use super::super::rows::corrupt;
use super::supplied;
use crate::storage::SqlStore;
use serde_json::json;
use yoneda_core::{
    Error, Result,
    git_object::ObjectId,
    txlog::{
        Checkpoint, TxEntry,
        archive::{Segment, SegmentCheckpoints, state_at as replay_segment},
    },
};

/// Most archived segments one command may bring in (about a megabyte each). A writer whose
/// concurrent window reaches further back than this is told to rebase.
const MAX_SEGMENTS: usize = 16;

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

/// `refname` at `version` when it has not moved since the floor: its value there. Below the
/// floor this is unknown here (the path index is archived too), so a landing on such a
/// base is not routed as a changeset: the merge path checks it against the segments.
pub fn ref_at_floor<S: SqlStore>(db: &S, refname: &str, version: u64) -> Result<Option<ObjectId>> {
    let anchor = anchor(db)?.filter(|a| a.version <= version);
    Ok(anchor.and_then(|a| a.refs.get(refname).copied()))
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
    Ok(segments_where(db, "start_version=?", &[start])?.pop())
}

/// The archived segments overlapping `(after, until]`, oldest first.
fn overlapping<S: SqlStore>(db: &S, after: u64, until: u64) -> Result<Vec<SegmentRow>> {
    segments_where(db, "end_version>? AND start_version<?", &[after, until])
}

/// The archived segment holding `version`.
fn holding<S: SqlStore>(db: &S, version: u64) -> Result<SegmentRow> {
    overlapping(db, version - 1, version)?.pop().ok_or_else(|| {
        Error::new(
            "TXLOG_INVALID",
            format!("No archived segment holds version {version}"),
        )
    })
}

fn segments_where<S: SqlStore>(db: &S, filter: &str, values: &[u64]) -> Result<Vec<SegmentRow>> {
    let params: Vec<_> = values.iter().map(|v| json!(v)).collect();
    db.query(
        &format!("SELECT * FROM txlog_segments WHERE {filter} ORDER BY start_version"),
        &params,
    )?
    .into_iter()
    .map(|row| {
        let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
        Ok(SegmentRow {
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
        })
    })
    .collect()
}

/// Asks for the objects the command did not carry, naming every one it needs.
fn require(keys: &[&str], what: &str) -> Result<()> {
    let missing: Vec<&str> = keys.iter().copied().filter(|k| !supplied::has(k)).collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(Error::new(
        "TXLOG_ARCHIVED",
        format!("{what} is archived in {}", missing.join(", ")),
    ))
}

impl SegmentRow {
    pub(super) fn digests(&self) -> (&str, &str) {
        (&self.segment_digest, &self.checkpoints_digest)
    }

    fn segment(&self) -> Result<Segment> {
        supplied::open(&self.segment_key, |text| {
            Segment::open(text, &self.segment_digest, self.start, self.end)
        })
    }

    fn checkpoints(&self) -> Result<SegmentCheckpoints> {
        supplied::open(&self.checkpoints_key, |text| {
            SegmentCheckpoints::open(text, &self.checkpoints_digest, self.start, self.end)
        })
    }
}

/// The ref state at an archived `version` (`0 < version < floor`).
pub fn state_at<S: SqlStore>(db: &S, version: u64) -> Result<Checkpoint> {
    let row = holding(db, version)?;
    let what = format!("Version {version}");
    require(&[&row.segment_key, &row.checkpoints_key], &what)?;
    let projected = super::super::projection_plan::projected_between(db, row.start, version)?;
    replay_segment(&row.segment()?, &row.checkpoints()?, version, &projected)
}

/// Archived entries after `after` (below the floor), up to `limit`, ending at the end of
/// the segment holding `after + 1`: a listing pages through the archive a segment a time.
pub fn page<S: SqlStore>(db: &S, after: u64, limit: u64) -> Result<Vec<TxEntry>> {
    let row = holding(db, after + 1)?;
    require(&[&row.segment_key], &format!("Version {}", after + 1))?;
    let until = row.end.min(after.saturating_add(limit));
    Ok(row.segment()?.entries[(after - row.start) as usize..(until - row.start) as usize].to_vec())
}

/// Archived entries `(after, until]` (`until` at most the floor), optionally for one ref,
/// for commands that check against the log (a landing's concurrent window, a stream's
/// cursor). More than `MAX_SEGMENTS` segments is refused: rebase onto a newer version.
pub fn entries<S: SqlStore>(
    db: &S,
    after: u64,
    until: u64,
    refname: Option<&str>,
) -> Result<Vec<TxEntry>> {
    let rows = overlapping(db, after, until)?;
    if rows.len() > MAX_SEGMENTS {
        return Err(Error::new(
            "TXLOG_COMPACTED",
            format!(
                "This needs the log after version {after}, {} archived segments back (at most {MAX_SEGMENTS}); rebase onto a newer version",
                rows.len()
            ),
        ));
    }
    let keys: Vec<&str> = rows.iter().map(|r| r.segment_key.as_str()).collect();
    require(&keys, &format!("The log after version {after}"))?;
    let mut out = Vec::new();
    for row in &rows {
        out.extend(row.segment()?.entries.into_iter().filter(|e| {
            e.version > after && e.version <= until && refname.is_none_or(|name| e.refname == name)
        }));
    }
    Ok(out)
}
