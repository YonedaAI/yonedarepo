//! Line diffs (histogram algorithm, as in `git diff --histogram`) and unified patches.
//! The same hunks feed review rendering and, later, three-way merge.
use imara_diff::{Algorithm, Diff, InternedInput};
use serde::Serialize;

/// Git's heuristic: a NUL byte in the first 8000 bytes means binary.
pub fn is_binary(data: &[u8]) -> bool {
    data.iter().take(8000).any(|b| *b == 0)
}

/// A changed region: `old_start`/`new_start` are 0-based line indexes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LineHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
}

/// Changed regions between two texts, split into lines (each keeps its terminator).
pub fn line_hunks(old: &[u8], new: &[u8]) -> Vec<LineHunk> {
    let input = InternedInput::new(old, new);
    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);
    diff.hunks()
        .map(|h| LineHunk {
            old_start: h.before.start,
            old_lines: h.before.end - h.before.start,
            new_start: h.after.start,
            new_lines: h.after.end - h.after.start,
        })
        .collect()
}

/// Lines of `data`, each including its `\n` when present.
pub fn split_lines(data: &[u8]) -> Vec<&[u8]> {
    data.split_inclusive(|b| *b == b'\n').collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PatchStats {
    pub additions: u32,
    pub deletions: u32,
}

/// A unified diff body (`@@` hunks only, no file headers) with `context` lines around
/// changes; nearby hunks merge like `git diff`. Missing final newlines are marked.
pub fn unified(old: &[u8], new: &[u8], context: u32) -> (String, PatchStats) {
    let (a, b) = (split_lines(old), split_lines(new));
    let hunks = line_hunks(old, new);
    let stats = PatchStats {
        additions: hunks.iter().map(|h| h.new_lines).sum(),
        deletions: hunks.iter().map(|h| h.old_lines).sum(),
    };
    let mut out = String::new();
    let mut i = 0;
    while i < hunks.len() {
        // Group hunks whose context windows touch.
        let mut j = i;
        while j + 1 < hunks.len()
            && hunks[j + 1].old_start <= hunks[j].old_start + hunks[j].old_lines + 2 * context
        {
            j += 1;
        }
        let first = &hunks[i];
        let last = &hunks[j];
        let old_from = first.old_start.saturating_sub(context);
        let old_to = (last.old_start + last.old_lines + context).min(a.len() as u32);
        let new_from = first.new_start.saturating_sub(context);
        let new_to = (last.new_start + last.new_lines + context).min(b.len() as u32);
        let range = |from: u32, to: u32| {
            let count = to - from;
            let start = if count == 0 { from } else { from + 1 };
            if count == 1 {
                format!("{start}")
            } else {
                format!("{start},{count}")
            }
        };
        out.push_str(&format!(
            "@@ -{} +{} @@\n",
            range(old_from, old_to),
            range(new_from, new_to)
        ));
        let mut line = |prefix: char, text: &[u8]| {
            out.push(prefix);
            out.push_str(&String::from_utf8_lossy(text));
            if !text.ends_with(b"\n") {
                out.push_str("\n\\ No newline at end of file\n");
            }
        };
        let mut old_at = old_from;
        for hunk in &hunks[i..=j] {
            for k in old_at..hunk.old_start {
                line(' ', a[k as usize]);
            }
            for k in hunk.old_start..hunk.old_start + hunk.old_lines {
                line('-', a[k as usize]);
            }
            for k in hunk.new_start..hunk.new_start + hunk.new_lines {
                line('+', b[k as usize]);
            }
            old_at = hunk.old_start + hunk.old_lines;
        }
        for k in old_at..old_to {
            line(' ', a[k as usize]);
        }
        i = j + 1;
    }
    (out, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unified_matches_git_shape() {
        let old = b"a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n";
        let new = b"a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nk\n";
        let (patch, stats) = unified(old, new, 3);
        assert_eq!(
            stats,
            PatchStats {
                additions: 2,
                deletions: 1
            }
        );
        assert_eq!(
            patch,
            "@@ -1,5 +1,5 @@\n a\n-b\n+B\n c\n d\n e\n@@ -8,3 +8,4 @@\n h\n i\n j\n+k\n"
        );
    }

    #[test]
    fn marks_missing_newline_and_empty_sides() {
        let (patch, _) = unified(b"", b"x", 3);
        assert_eq!(patch, "@@ -0,0 +1 @@\n+x\n\\ No newline at end of file\n");
        let (patch, stats) = unified(b"same\n", b"same\n", 3);
        assert!(patch.is_empty() && stats.additions == 0);
    }

    #[test]
    fn detects_binary() {
        assert!(is_binary(b"PK\0\x03"));
        assert!(!is_binary(b"plain text\n"));
    }
}
