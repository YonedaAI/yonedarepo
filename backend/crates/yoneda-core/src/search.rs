//! Code search over immutable partitions. A segment indexes one partition (a top-level
//! subtree) by case-folded trigrams; because a partition is identified by its tree id,
//! a segment built once is reused by every commit and branch that contains that subtree,
//! so only changed partitions are ever indexed (derived data, recursively from parents).
//! A segment's paths are relative to its partition root and the reader prefixes them:
//! a subtree id says nothing about where the subtree sits, so a renamed or duplicated
//! directory reuses the segment under its own path (Part II, repair (b) of key sufficiency).
use crate::git_object::ObjectId;
use crate::textdiff::is_binary;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

mod grep;
pub mod stored;
pub use grep::{Grep, LineMatch, binary_path, grep};
pub use stored::StoredSegment;

/// Files larger than this are listed but not indexed (searched only by path).
pub const MAX_INDEXED_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentFile {
    pub path: String,
    pub id: ObjectId,
    /// False for binary or oversized files: never content candidates.
    pub indexed: bool,
    /// Why an unindexed file's content is not searched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
}

/// A segment as built; it is stored and read in its compact form (`stored`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Segment {
    pub files: Vec<SegmentFile>,
    /// A case-folded trigram -> indexes into `files`, ascending.
    pub grams: BTreeMap<[u8; 3], Vec<u32>>,
}

fn fold(data: &[u8]) -> Vec<u8> {
    data.to_ascii_lowercase()
}

fn trigrams(data: &[u8]) -> BTreeSet<[u8; 3]> {
    data.windows(3)
        .filter(|w| !w.contains(&b'\n'))
        .map(|w| [w[0], w[1], w[2]])
        .collect()
}

/// Builds a segment from a partition's files (path, blob id, content; `None` for a file
/// known to be over `MAX_INDEXED_BYTES`, listed by path only as if its content were read).
pub fn build_segment(files: &[(String, ObjectId, Option<Vec<u8>>)]) -> Segment {
    let mut segment = Segment::default();
    for (index, (path, id, data)) in files.iter().enumerate() {
        let skipped = match data.as_deref() {
            Some(d) if d.len() <= MAX_INDEXED_BYTES && !is_binary(d) => None,
            Some(d) if d.len() <= MAX_INDEXED_BYTES => Some("binary".to_string()),
            _ => Some(format!(
                "larger than {} MiB",
                MAX_INDEXED_BYTES / (1024 * 1024)
            )),
        };
        segment.files.push(SegmentFile {
            path: path.clone(),
            id: *id,
            indexed: skipped.is_none(),
            skipped: skipped.clone(),
        });
        let content = data.as_deref().filter(|_| skipped.is_none());
        for gram in content.map(|d| trigrams(&fold(d))).unwrap_or_default() {
            segment.grams.entry(gram).or_default().push(index as u32);
        }
    }
    segment
}

/// Files of `files` that may contain `query` (case-insensitive superset; `posting` answers a
/// trigram's file indexes) or whose path matches, with paths under `prefix`, the directory
/// the partition sits at in the queried tree.
fn candidates(
    files: &[SegmentFile],
    prefix: &str,
    query: &str,
    posting: impl Fn(&[u8; 3]) -> crate::Result<BTreeSet<u32>>,
) -> crate::Result<Vec<SegmentFile>> {
    let folded = fold(query.as_bytes());
    let mut by_content: Option<BTreeSet<u32>> = None;
    for gram in &trigrams(&folded) {
        let found = posting(gram)?;
        by_content = Some(match by_content {
            None => found,
            Some(current) => current.intersection(&found).copied().collect(),
        });
    }
    let lowered = String::from_utf8_lossy(&folded).into_owned();
    Ok(files
        .iter()
        .enumerate()
        .filter_map(|(i, f)| {
            let path = if prefix.is_empty() {
                f.path.clone()
            } else {
                format!("{prefix}/{}", f.path)
            };
            let hit = path.to_ascii_lowercase().contains(&lowered)
                || (f.indexed
                    && by_content
                        .as_ref()
                        .is_none_or(|set| set.contains(&(i as u32))));
            hit.then(|| SegmentFile { path, ..f.clone() })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_object::{ObjectKind, hash_object};

    fn segment() -> Segment {
        let file = |p: &str, t: &str| {
            (
                p.to_string(),
                hash_object(ObjectKind::Blob, t.as_bytes()),
                Some(t.as_bytes().to_vec()),
            )
        };
        build_segment(&[
            file("retry.rs", "fn retry_with_backoff() {}\n"),
            file("lib.rs", "pub mod retry;\n"),
            file("img.png", "\0PNG"),
        ])
    }

    #[test]
    fn trigram_candidates_are_a_superset_of_matches() {
        let bytes = segment().encode().unwrap();
        let s = StoredSegment::open(&bytes).unwrap();
        let paths = |q: &str| {
            s.candidates("src", q)
                .unwrap()
                .into_iter()
                .map(|f| f.path)
                .collect::<Vec<_>>()
        };
        assert_eq!(paths("Backoff"), ["src/retry.rs"]);
        assert_eq!(paths("retry"), ["src/retry.rs", "src/lib.rs"]);
        assert_eq!(paths("lib.rs"), ["src/lib.rs"], "paths match too");
        assert_eq!(
            paths("src/lib"),
            ["src/lib.rs"],
            "under the partition's prefix"
        );
        assert!(paths("PNG").is_empty() || paths("PNG") == ["src/img.png"]);
        // The same segment answers for the subtree wherever it sits.
        let moved = s.candidates("lib", "Backoff").unwrap();
        assert_eq!(moved[0].path, "lib/retry.rs");
        assert_eq!(s.candidates("", "Backoff").unwrap()[0].path, "retry.rs");
        assert!(!s.files[2].indexed, "binary files are not content-indexed");
    }
}
