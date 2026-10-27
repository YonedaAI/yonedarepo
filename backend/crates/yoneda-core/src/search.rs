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

/// Files larger than this are listed but not indexed (searched only by path).
pub const MAX_INDEXED_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentFile {
    pub path: String,
    pub id: ObjectId,
    /// False for binary or oversized files: never content candidates.
    pub indexed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub files: Vec<SegmentFile>,
    /// Hex of a case-folded trigram -> indexes into `files`.
    pub grams: BTreeMap<String, Vec<u32>>,
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

fn hex(gram: &[u8; 3]) -> String {
    format!("{:02x}{:02x}{:02x}", gram[0], gram[1], gram[2])
}

/// Builds a segment from a partition's files (path, blob id, content).
pub fn build_segment(files: &[(String, ObjectId, Vec<u8>)]) -> Segment {
    let mut segment = Segment::default();
    for (index, (path, id, data)) in files.iter().enumerate() {
        let indexed = data.len() <= MAX_INDEXED_BYTES && !is_binary(data);
        segment.files.push(SegmentFile {
            path: path.clone(),
            id: *id,
            indexed,
        });
        if indexed {
            for gram in trigrams(&fold(data)) {
                segment
                    .grams
                    .entry(hex(&gram))
                    .or_default()
                    .push(index as u32);
            }
        }
    }
    segment
}

impl Segment {
    /// Files that may contain `query` (case-insensitive superset) or whose path matches,
    /// with paths under `prefix`, the directory the partition sits at in the queried tree.
    pub fn candidates(&self, prefix: &str, query: &str) -> Vec<SegmentFile> {
        let folded = fold(query.as_bytes());
        let grams = trigrams(&folded);
        let mut by_content: Option<BTreeSet<u32>> = None;
        for gram in &grams {
            let posting: BTreeSet<u32> = self
                .grams
                .get(&hex(gram))
                .map(|p| p.iter().copied().collect())
                .unwrap_or_default();
            by_content = Some(match by_content {
                None => posting,
                Some(current) => current.intersection(&posting).copied().collect(),
            });
        }
        let lowered = String::from_utf8_lossy(&folded).into_owned();
        self.files
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
            .collect()
    }
}

/// A matching line: 1-based number and text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LineMatch {
    pub line: u32,
    pub text: String,
}

/// Lines of `data` containing `query` (optionally case-insensitive), up to `max`.
pub fn grep(data: &[u8], query: &str, ignore_case: bool, max: usize) -> Vec<LineMatch> {
    if is_binary(data) || query.is_empty() {
        return Vec::new();
    }
    let needle = if ignore_case {
        fold(query.as_bytes())
    } else {
        query.as_bytes().to_vec()
    };
    data.split(|b| *b == b'\n')
        .enumerate()
        .filter(|(_, line)| {
            let hay = if ignore_case {
                fold(line)
            } else {
                line.to_vec()
            };
            hay.windows(needle.len().max(1))
                .any(|w| w == needle.as_slice())
        })
        .take(max)
        .map(|(i, line)| LineMatch {
            line: i as u32 + 1,
            text: String::from_utf8_lossy(line).chars().take(500).collect(),
        })
        .collect()
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
                t.as_bytes().to_vec(),
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
        let s = segment();
        let paths = |q: &str| {
            s.candidates("src", q)
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
        let moved = s.candidates("lib", "Backoff");
        assert_eq!(moved[0].path, "lib/retry.rs");
        assert_eq!(s.candidates("", "Backoff")[0].path, "retry.rs");
        assert!(!s.files[2].indexed, "binary files are not content-indexed");
    }

    #[test]
    fn grep_finds_lines_with_case_control() {
        let data = b"one\nRetry here\nretry there\n";
        assert_eq!(
            grep(data, "retry", false, 10),
            vec![LineMatch {
                line: 3,
                text: "retry there".into()
            }]
        );
        assert_eq!(grep(data, "retry", true, 10).len(), 2);
        assert_eq!(grep(data, "retry", true, 1).len(), 1);
    }
}
