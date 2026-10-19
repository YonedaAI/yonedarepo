//! Three-way text merge (diff3) on lines, with Git's conflict rules: changes that overlap
//! or touch the same base lines conflict unless both sides made the identical change;
//! two insertions at the same point conflict unless identical. Binary content never
//! merges textually.
use crate::Result;
use crate::git_object::{FileMode, ObjectId, TreeChange, TreeEntry, Walk, diff_trees};
use crate::textdiff::{LineHunk, is_binary, line_hunks, split_lines};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A conflicting region, as line indexes into each side's text.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct ConflictRegion {
    pub base_start: u32,
    pub base_lines: u32,
    pub ours_start: u32,
    pub ours_lines: u32,
    pub theirs_start: u32,
    pub theirs_lines: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextMerge {
    Clean(Vec<u8>),
    /// `marked` holds the merge with diff3-style markers for a resolver.
    Conflict {
        marked: Vec<u8>,
        regions: Vec<ConflictRegion>,
    },
    /// Binary content changed on both sides differently.
    Binary,
}

#[derive(Clone, Copy)]
struct Side<'a> {
    lines: &'a [&'a [u8]],
    hunks: &'a [LineHunk],
}

impl Side<'_> {
    /// This side's text for base lines `[lo, hi)`, applying its hunks inside the range.
    fn region(&self, base: &[&[u8]], lo: u32, hi: u32) -> (u32, Vec<u8>, u32) {
        let mut out = Vec::new();
        let mut at = lo;
        // Map `lo` into this side's line numbering via the hunks before it.
        let mut offset: i64 = 0;
        for h in self.hunks {
            if h.old_start + h.old_lines <= lo && !(h.old_lines == 0 && h.old_start == lo) {
                offset += i64::from(h.new_lines) - i64::from(h.old_lines);
            }
        }
        let start = (i64::from(lo) + offset) as u32;
        let mut count = 0;
        for h in self
            .hunks
            .iter()
            .filter(|h| h.old_start >= lo && h.old_start + h.old_lines <= hi)
            .filter(|h| !(h.old_lines == 0 && h.old_start == hi && hi > lo))
        {
            for line in &base[at as usize..h.old_start as usize] {
                out.extend_from_slice(line);
                count += 1;
            }
            for line in &self.lines[h.new_start as usize..(h.new_start + h.new_lines) as usize] {
                out.extend_from_slice(line);
                count += 1;
            }
            at = h.old_start + h.old_lines;
        }
        for line in &base[at as usize..hi as usize] {
            out.extend_from_slice(line);
            count += 1;
        }
        (start, out, count)
    }
}

/// Merges `ours` and `theirs`, both derived from `base`.
pub fn merge3(base: &[u8], ours: &[u8], theirs: &[u8]) -> TextMerge {
    if ours == theirs || theirs == base {
        return TextMerge::Clean(ours.to_vec());
    }
    if ours == base {
        return TextMerge::Clean(theirs.to_vec());
    }
    if is_binary(base) || is_binary(ours) || is_binary(theirs) {
        return TextMerge::Binary;
    }
    let base_lines = split_lines(base);
    let (ours_lines, theirs_lines) = (split_lines(ours), split_lines(theirs));
    let (ours_hunks, theirs_hunks) = (line_hunks(base, ours), line_hunks(base, theirs));
    let a = Side {
        lines: &ours_lines,
        hunks: &ours_hunks,
    };
    let b = Side {
        lines: &theirs_lines,
        hunks: &theirs_hunks,
    };
    // Every hunk tagged with its side, in base order.
    let mut all: Vec<(u8, &LineHunk)> = ours_hunks
        .iter()
        .map(|h| (0, h))
        .chain(theirs_hunks.iter().map(|h| (1, h)))
        .collect();
    all.sort_by_key(|(side, h)| (h.old_start, h.old_start + h.old_lines, *side));

    let mut out = Vec::new();
    let mut marked = Vec::new();
    let mut regions = Vec::new();
    let mut at = 0u32;
    let mut i = 0;
    while i < all.len() {
        // A group: hunks whose base ranges overlap or touch (Git conflicts on adjacency).
        let lo = all[i].1.old_start;
        let mut hi = lo + all[i].1.old_lines;
        let mut sides = 1u8 << all[i].0;
        let mut j = i + 1;
        while j < all.len() && all[j].1.old_start <= hi {
            hi = hi.max(all[j].1.old_start + all[j].1.old_lines);
            sides |= 1 << all[j].0;
            j += 1;
        }
        for line in &base_lines[at as usize..lo as usize] {
            out.extend_from_slice(line);
            marked.extend_from_slice(line);
        }
        let (ours_start, ours_text, ours_count) = a.region(&base_lines, lo, hi);
        let (theirs_start, theirs_text, theirs_count) = b.region(&base_lines, lo, hi);
        let resolved = match sides {
            0b01 => Some(&ours_text),
            0b10 => Some(&theirs_text),
            _ if ours_text == theirs_text => Some(&ours_text),
            _ => None,
        };
        match resolved {
            Some(text) => {
                out.extend_from_slice(text);
                marked.extend_from_slice(text);
            }
            None => {
                let base_text: Vec<u8> = base_lines[lo as usize..hi as usize].concat();
                let block = |m: &mut Vec<u8>, label: &[u8], text: &[u8]| {
                    m.extend_from_slice(label);
                    m.extend_from_slice(text);
                    if !text.is_empty() && !text.ends_with(b"\n") {
                        m.push(b'\n');
                    }
                };
                block(&mut marked, b"<<<<<<< ours\n", &ours_text);
                block(&mut marked, b"||||||| base\n", &base_text);
                block(&mut marked, b"=======\n", &theirs_text);
                marked.extend_from_slice(b">>>>>>> theirs\n");
                regions.push(ConflictRegion {
                    base_start: lo,
                    base_lines: hi - lo,
                    ours_start,
                    ours_lines: ours_count,
                    theirs_start,
                    theirs_lines: theirs_count,
                });
            }
        }
        at = hi;
        i = j;
    }
    for line in &base_lines[at as usize..] {
        out.extend_from_slice(line);
        marked.extend_from_slice(line);
    }
    if regions.is_empty() {
        TextMerge::Clean(out)
    } else {
        TextMerge::Conflict { marked, regions }
    }
}

/// One file's state on a side: mode and blob id (`None`: absent).
pub type Entry = Option<(FileMode, ObjectId)>;

/// Why a path cannot merge automatically.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PathConflictKind {
    /// Both sides changed the content and the text merge conflicted (or is binary).
    Content,
    ModifyDelete,
    AddAdd,
    /// Incompatible mode changes (or symlink/submodule content changes on both sides).
    Mode,
    /// One side has a file where the other has a directory.
    DirectoryFile,
}

/// A file both sides changed, whose content must be merged with the blobs in hand.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContentMerge {
    pub path: String,
    pub mode: FileMode,
    pub base: Option<ObjectId>,
    pub ours: ObjectId,
    pub theirs: ObjectId,
}

/// The result of merging `theirs` into `ours` relative to `base`, expressed as changes
/// to apply on top of `ours`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TreeMerge {
    /// Paths taken from theirs as-is.
    pub take: Vec<(String, Entry)>,
    /// Paths needing a content merge.
    pub content: Vec<ContentMerge>,
    pub conflicts: Vec<(String, PathConflictKind)>,
}

fn is_dir_prefix(dir: &str, path: &str) -> bool {
    path.len() > dir.len() && path.starts_with(dir) && path.as_bytes()[dir.len()] == b'/'
}

/// Three-way tree merge at path level, descending only into changed subtrees.
pub fn merge_trees(
    base: Option<ObjectId>,
    ours: Option<ObjectId>,
    theirs: Option<ObjectId>,
    trees: &HashMap<ObjectId, Vec<TreeEntry>>,
    limit: usize,
) -> Result<Walk<TreeMerge>> {
    let (ours_diff, theirs_diff) = match (
        diff_trees(base, ours, trees, limit)?,
        diff_trees(base, theirs, trees, limit)?,
    ) {
        (Walk::Done(a), Walk::Done(b)) => (a, b),
        (a, b) => {
            let mut need = BTreeSet::new();
            for walk in [a, b] {
                if let Walk::Need(ids) = walk {
                    need.extend(ids);
                }
            }
            return Ok(Walk::Need(need));
        }
    };
    let ours_by_path: BTreeMap<&str, &TreeChange> =
        ours_diff.iter().map(|c| (c.path.as_str(), c)).collect();
    let mut merge = TreeMerge::default();
    for change in &theirs_diff {
        let path = change.path.clone();
        // Directory/file: one side adds a file where the other has entries beneath it.
        let clash = ours_diff.iter().any(|o| {
            (o.new.is_some() && is_dir_prefix(&o.path, &path) && change.new.is_some())
                || (change.new.is_some() && is_dir_prefix(&path, &o.path) && o.new.is_some())
        });
        if clash {
            merge
                .conflicts
                .push((path, PathConflictKind::DirectoryFile));
            continue;
        }
        let Some(mine) = ours_by_path.get(path.as_str()) else {
            merge.take.push((path, change.new));
            continue;
        };
        if mine.new == change.new {
            continue;
        }
        let kind = match (change.old, mine.new, change.new) {
            (_, None, Some(_)) | (_, Some(_), None) => Some(PathConflictKind::ModifyDelete),
            (None, Some(_), Some(_)) => Some(PathConflictKind::AddAdd),
            _ => None,
        };
        if let Some(kind) = kind {
            merge.conflicts.push((path, kind));
            continue;
        }
        let (Some((base_mode, base_id)), Some((our_mode, our_id)), Some((their_mode, their_id))) =
            (change.old, mine.new, change.new)
        else {
            continue;
        };
        let mode = if our_mode == their_mode || their_mode == base_mode {
            our_mode
        } else if our_mode == base_mode {
            their_mode
        } else {
            merge.conflicts.push((path, PathConflictKind::Mode));
            continue;
        };
        // One side changed only the mode: the other side's content wins, no text merge.
        if our_id == their_id || our_id == base_id {
            merge.take.push((path, Some((mode, their_id))));
        } else if their_id == base_id {
            if mode != our_mode {
                merge.take.push((path, Some((mode, our_id))));
            }
        } else if !matches!(mode, FileMode::Blob | FileMode::Executable) {
            merge.conflicts.push((path, PathConflictKind::Mode));
        } else {
            merge.content.push(ContentMerge {
                path,
                mode,
                base: Some(base_id),
                ours: our_id,
                theirs: their_id,
            });
        }
    }
    Ok(Walk::Done(merge))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean(base: &str, ours: &str, theirs: &str) -> String {
        match merge3(base.as_bytes(), ours.as_bytes(), theirs.as_bytes()) {
            TextMerge::Clean(bytes) => String::from_utf8(bytes).unwrap(),
            other => panic!("expected a clean merge, got {other:?}"),
        }
    }
    fn conflicts(base: &str, ours: &str, theirs: &str) -> (String, usize) {
        match merge3(base.as_bytes(), ours.as_bytes(), theirs.as_bytes()) {
            TextMerge::Conflict { marked, regions } => {
                (String::from_utf8(marked).unwrap(), regions.len())
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
    }

    const BASE: &str = "fn a() {\n    1\n}\n\nfn b() {\n    2\n}\n\nfn c() {\n    3\n}\n";

    #[test]
    fn disjoint_functions_in_one_file_merge() {
        let ours = BASE.replace("    1\n", "    10\n");
        let theirs = BASE.replace("    3\n", "    30\n");
        assert_eq!(
            clean(BASE, &ours, &theirs),
            BASE.replace("    1\n", "    10\n")
                .replace("    3\n", "    30\n")
        );
    }

    #[test]
    fn identical_changes_merge_once() {
        let both = BASE.replace("    2\n", "    20\n");
        assert_eq!(clean(BASE, &both, &both), both);
        let ours = BASE
            .replace("    2\n", "    20\n")
            .replace("    1\n", "    10\n");
        assert_eq!(clean(BASE, &ours, &both), ours);
    }

    #[test]
    fn overlapping_and_adjacent_changes_conflict() {
        let (marked, n) = conflicts(
            BASE,
            &BASE.replace("    2\n", "    ours\n"),
            &BASE.replace("    2\n", "    theirs\n"),
        );
        assert_eq!(n, 1);
        assert!(marked.contains(
            "<<<<<<< ours\n    ours\n||||||| base\n    2\n=======\n    theirs\n>>>>>>> theirs\n"
        ));
        // Adjacent lines (2 and the closing brace after it) conflict, as in Git.
        let ours = BASE.replace("fn b() {\n    2\n", "fn b() {\n    two\n");
        let theirs = BASE.replace("    2\n}\n\nfn c", "    2\n} // end b\n\nfn c");
        assert_eq!(conflicts(BASE, &ours, &theirs).1, 1);
    }

    #[test]
    fn ambiguous_insertions_conflict_unless_identical() {
        let base = "a\nb\n";
        assert_eq!(conflicts(base, "a\nx\nb\n", "a\ny\nb\n").1, 1);
        assert_eq!(clean(base, "a\nx\nb\n", "a\nx\nb\n"), "a\nx\nb\n");
        assert_eq!(clean(base, "x\na\nb\n", "a\nb\ny\n"), "x\na\nb\ny\n");
    }

    #[test]
    fn deletions_and_one_sided_changes() {
        assert_eq!(
            clean(BASE, &BASE.replace("fn c() {\n    3\n}\n", ""), BASE),
            BASE.replace("fn c() {\n    3\n}\n", "")
        );
        let ours = BASE.replace("fn a() {\n    1\n}\n\n", "");
        let theirs = BASE.replace("    3\n", "    30\n");
        assert_eq!(
            clean(BASE, &ours, &theirs),
            ours.replace("    3\n", "    30\n")
        );
    }

    #[test]
    fn binary_content_never_merges_textually() {
        assert_eq!(merge3(b"\0a", b"\0b", b"\0c"), TextMerge::Binary);
        assert_eq!(
            merge3(b"\0a", b"\0b", b"\0a"),
            TextMerge::Clean(b"\0b".to_vec())
        );
    }

    #[test]
    fn missing_final_newlines_survive() {
        assert_eq!(
            clean("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD"),
            "A\nb\nc\nD"
        );
        // Adjacent edits conflict, as with `git merge-file`.
        assert_eq!(conflicts("a\nb", "A\nb", "a\nB").1, 1);
    }
}
