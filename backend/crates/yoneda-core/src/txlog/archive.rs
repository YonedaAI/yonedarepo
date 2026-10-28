//! Archived log segments: whole runs of old log versions moved out of the authority's SQL
//! store into the object store, so the store keeps a bounded tail. A segment holds the
//! entries `(start, end]`; its checkpoint object holds the ref state at `start` (the base
//! replay starts from) and the checkpoints that were stored inside the run. Each object is
//! sealed with the fingerprint of its JSON, which the authority keeps: a segment read back
//! with any other content is refused before replay, and replay still verifies the chain.
use super::{Checkpoint, TxEntry, invalid, replay_projected};
use crate::{Error, Result, git_object::ObjectId};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::collections::BTreeMap;

/// Versions per segment. A multiple of the checkpoint interval, so segment boundaries are
/// checkpoint versions, and small enough that one historical read moves about a megabyte.
pub const SEGMENT_VERSIONS: u64 = 1024;
const FORMAT: u32 = 1;

/// The log entries `(start, end]`, in order.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Segment {
    pub format: u32,
    pub start: u64,
    pub end: u64,
    pub entries: Vec<TxEntry>,
}

/// A checkpoint row as it was stored (its ref-map digest is absent on old rows).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredCheckpoint {
    pub checkpoint: Checkpoint,
    pub refs_digest: Option<String>,
}

/// The ref state at a segment's `start` and the checkpoints stored in `(start, end]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SegmentCheckpoints {
    pub format: u32,
    pub start: u64,
    pub end: u64,
    pub base: Checkpoint,
    pub base_refs_digest: String,
    pub stored: Vec<StoredCheckpoint>,
}

/// An object ready for the store: where it goes, its exact bytes and its fingerprint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Sealed {
    pub key: String,
    pub body: String,
    pub digest: String,
}

/// Object keys, relative to the repository's prefix; zero-padded so they sort by version.
pub fn segment_key(start: u64, end: u64) -> String {
    format!("_log/segment-{start:020}-{end:020}.json")
}
pub fn checkpoint_key(start: u64) -> String {
    format!("_log/checkpoint-{start:020}.json")
}

fn corrupt(what: &str, why: impl std::fmt::Display) -> Error {
    Error::new("ARCHIVE_CORRUPT", format!("Archived {what} {why}"))
}

fn seal(key: String, value: &impl Serialize) -> Result<Sealed> {
    let value = serde_json::to_value(value).map_err(|e| invalid(e.to_string()))?;
    Ok(Sealed {
        key,
        digest: crate::fingerprint(&value)?,
        body: serde_json::to_string(&value).map_err(|e| invalid(e.to_string()))?,
    })
}

/// Parses an archived object only when its JSON still has the fingerprint sealed with it.
fn open<T: DeserializeOwned>(what: &str, text: &str, digest: &str) -> Result<T> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| corrupt(what, format!("is not JSON: {e}")))?;
    if crate::fingerprint(&value)? != digest {
        return Err(corrupt(what, "does not match its recorded digest"));
    }
    serde_json::from_value(value).map_err(|e| corrupt(what, e))
}

impl Segment {
    /// Seals `entries` as the segment `(start, end]`; they must be exactly that run.
    pub fn seal(start: u64, end: u64, entries: Vec<TxEntry>) -> Result<Sealed> {
        let segment = Self {
            format: FORMAT,
            start,
            end,
            entries,
        };
        segment.check_shape()?;
        seal(segment_key(start, end), &segment)
    }

    pub fn open(text: &str, digest: &str, start: u64, end: u64) -> Result<Self> {
        let segment: Self = open("segment", text, digest)?;
        if (segment.start, segment.end) != (start, end) {
            return Err(corrupt("segment", "covers other versions"));
        }
        segment.check_shape()?;
        Ok(segment)
    }

    fn check_shape(&self) -> Result<()> {
        let contiguous = self.format == FORMAT
            && self.end > self.start
            && self.entries.len() as u64 == self.end - self.start
            && self
                .entries
                .iter()
                .zip(self.start + 1..)
                .all(|(e, v)| e.version == v);
        if !contiguous {
            return Err(corrupt("segment", "is not a contiguous run of versions"));
        }
        Ok(())
    }

    /// The chain digest of the segment's last entry: what the retained tail chains from.
    pub fn last_chain(&self) -> &str {
        self.entries.last().map_or("", |e| e.chain.as_str())
    }
}

impl SegmentCheckpoints {
    pub fn seal(
        start: u64,
        end: u64,
        base: Checkpoint,
        stored: Vec<StoredCheckpoint>,
    ) -> Result<Sealed> {
        let archive = Self {
            format: FORMAT,
            start,
            end,
            base_refs_digest: base.refs_digest()?,
            base,
            stored,
        };
        seal(checkpoint_key(start), &archive)
    }

    pub fn open(text: &str, digest: &str, start: u64, end: u64) -> Result<Self> {
        let archive: Self = open("checkpoints", text, digest)?;
        if archive.format != FORMAT
            || (archive.start, archive.end, archive.base.version) != (start, end, start)
        {
            return Err(corrupt("checkpoints", "cover other versions"));
        }
        if archive.base.refs_digest()? != archive.base_refs_digest {
            return Err(corrupt(
                "checkpoints",
                "have a base that disagrees with its digest",
            ));
        }
        Ok(archive)
    }
}

/// The ref state at `version` (inside `(start, end]`) from a segment and its checkpoints:
/// the newest verified checkpoint at or before it, then a verified replay. `projected`
/// gives the Git commit of each changeset version, as for the retained log.
pub fn state_at(
    segment: &Segment,
    checkpoints: &SegmentCheckpoints,
    version: u64,
    projected: &BTreeMap<u64, ObjectId>,
) -> Result<Checkpoint> {
    if version <= segment.start || version > segment.end {
        return Err(invalid(format!(
            "Version {version} is outside segment ({}, {}]",
            segment.start, segment.end
        )));
    }
    let entry = |v: u64| segment.entries.get((v - segment.start - 1) as usize);
    let mut from = &checkpoints.base;
    for stored in &checkpoints.stored {
        let (cp, Some(digest)) = (&stored.checkpoint, &stored.refs_digest) else {
            continue;
        };
        if cp.version <= version && cp.version > from.version {
            if entry(cp.version).map(|e| e.chain.as_str()) != Some(cp.chain.as_str()) {
                return Err(corrupt("checkpoints", "disagree with the segment's log"));
            }
            let next = (cp.version < segment.end)
                .then(|| entry(cp.version + 1))
                .flatten();
            cp.verify(digest, next)?;
            from = cp;
        }
    }
    let tail = &segment.entries
        [(from.version - segment.start) as usize..(version - segment.start) as usize];
    replay_projected(from, tail, projected)
}

#[cfg(test)]
mod tests;
