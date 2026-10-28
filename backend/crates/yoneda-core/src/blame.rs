//! Line attribution (blame) from a file's version history, oldest first. Each version's
//! lines keep the commit that last changed them; diffs between consecutive versions use
//! the same histogram hunks as patches and merges.
use crate::git_object::ObjectId;
use crate::textdiff::{line_hunks, split_lines};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BlameLine {
    pub line: u32,
    pub commit: ObjectId,
    pub text: String,
}

/// `versions`: (commit, content) from oldest to newest. The oldest version's lines are
/// attributed to it (a history boundary, like `git blame`'s `^`).
pub fn blame(versions: &[(ObjectId, Vec<u8>)]) -> Vec<BlameLine> {
    let Some((first_commit, first)) = versions.first() else {
        return Vec::new();
    };
    let mut owners: Vec<ObjectId> = vec![*first_commit; split_lines(first).len()];
    for pair in versions.windows(2) {
        let ((_, old), (commit, new)) = (&pair[0], &pair[1]);
        let mut next = Vec::with_capacity(split_lines(new).len());
        let mut at = 0u32;
        for hunk in line_hunks(old, new) {
            next.extend(owners[at as usize..hunk.old_start as usize].iter().copied());
            next.extend(std::iter::repeat_n(*commit, hunk.new_lines as usize));
            at = hunk.old_start + hunk.old_lines;
        }
        next.extend(owners[at as usize..].iter().copied());
        owners = next;
    }
    let newest = &versions[versions.len() - 1].1;
    split_lines(newest)
        .iter()
        .zip(owners)
        .enumerate()
        .map(|(i, (text, commit))| BlameLine {
            line: i as u32 + 1,
            commit,
            text: String::from_utf8_lossy(text)
                .trim_end_matches('\n')
                .to_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(n: u8) -> ObjectId {
        ObjectId::from_bytes([n; 20])
    }

    #[test]
    fn attributes_each_line_to_its_last_change() {
        let versions = vec![
            (id(1), b"a\nb\nc\n".to_vec()),
            (id(2), b"a\nB\nc\n".to_vec()),
            (id(3), b"a\nB\nc\nd\n".to_vec()),
        ];
        let owners: Vec<ObjectId> = blame(&versions).iter().map(|l| l.commit).collect();
        assert_eq!(owners, vec![id(1), id(2), id(1), id(3)]);
        assert_eq!(blame(&versions)[1].text, "B");
    }

    #[test]
    fn deleted_lines_vanish_and_boundary_owns_the_rest() {
        let versions = vec![(id(1), b"x\ny\nz\n".to_vec()), (id(2), b"x\nz\n".to_vec())];
        let lines = blame(&versions);
        assert_eq!(
            lines.iter().map(|l| (l.line, l.commit)).collect::<Vec<_>>(),
            vec![(1, id(1)), (2, id(1))]
        );
        assert!(blame(&[]).is_empty());
    }

    #[test]
    fn keeps_whole_lines_however_long() {
        let long = "x".repeat(2000);
        let lines = blame(&[(id(1), format!("{long}\nshort\n").into_bytes())]);
        assert_eq!(lines[0].text, long);
        assert_eq!(lines[1].text, "short");
    }
}
