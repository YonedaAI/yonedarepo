//! Fetch efficiency, per clone: the bytes fetched from the platform against the bytes of
//! the files its coding agents read. Both are tallied under `$GIT_DIR/yoneda/`, never
//! committed, and reported with each session record:
//! - `fetched`: one `<kind> <objects> <bytes>` line per pack the helper or CLI wrote
//!   (object content bytes, as Git stores them uncompressed), appended by every fetch;
//! - `read-bytes`: one `<bytes> <path>` line per distinct file a hook saw read, sized in
//!   the work tree when it was first read.
//!
//! Appends are whole lines in one write, so concurrent helpers (Git runs one per lazy
//! fetch) never interleave; a torn last line is skipped.
use crate::error::{Context, Result};
use crate::git::Git;
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use yoneda_core::git_object::ObjectKind;

const FETCHED: &str = "fetched";
const READ_BYTES: &str = "read-bytes";

/// Objects and bytes fetched into one clone.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Fetched {
    pub objects: u64,
    pub bytes: u64,
    pub blobs: u64,
    pub blob_bytes: u64,
}

fn append(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context(format!("creating {}", dir.display()))?;
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .context(format!("writing {}", path.display()))
}

fn lines(path: &Path) -> Result<Vec<String>> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(text.lines().map(str::to_owned).collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e).context(format!("reading {}", path.display())),
    }
}

/// Counts `objects`, just written into the repository `git` names explicitly (the helper's;
/// other callers are not tallied).
pub fn count_fetched(git: &Git, objects: &[(ObjectKind, &[u8])]) -> Result<()> {
    let Some(git_dir) = git.git_dir() else {
        return Ok(());
    };
    let mut text = String::new();
    for kind in [
        ObjectKind::Commit,
        ObjectKind::Tree,
        ObjectKind::Blob,
        ObjectKind::Tag,
    ] {
        let of_kind = objects.iter().filter(|(k, _)| *k == kind);
        let (count, bytes) = of_kind.fold((0u64, 0u64), |(n, b), (_, data)| {
            (n + 1, b + data.len() as u64)
        });
        if count > 0 {
            text.push_str(&format!("{} {count} {bytes}\n", kind.name()));
        }
    }
    if text.is_empty() {
        return Ok(());
    }
    append(&git_dir.join("yoneda").join(FETCHED), &text)
}

/// Everything fetched into the clone at `git_dir`.
pub fn fetched(git_dir: &Path) -> Result<Fetched> {
    let mut total = Fetched::default();
    for line in lines(&git_dir.join("yoneda").join(FETCHED))? {
        let words: Vec<&str> = line.split(' ').collect();
        let [kind, count, bytes] = words[..] else {
            continue;
        };
        let (Ok(count), Ok(bytes)) = (count.parse::<u64>(), bytes.parse::<u64>()) else {
            continue;
        };
        total.objects += count;
        total.bytes += bytes;
        if kind == "blob" {
            total.blobs += count;
            total.blob_bytes += bytes;
        }
    }
    Ok(total)
}

/// Notes the sizes of `paths` (relative to the work tree `top`) read in the clone at
/// `git_dir`, once per path; directories and vanished files are not files read.
pub fn note_reads(git_dir: &Path, top: &Path, paths: &[String]) -> Result<()> {
    let file = git_dir.join("yoneda").join(READ_BYTES);
    let mut known: HashSet<String> = lines(&file)?
        .iter()
        .filter_map(|l| l.split_once(' ').map(|(_, path)| path.to_owned()))
        .collect();
    let mut text = String::new();
    for path in paths {
        if path.contains('\n') || !known.insert(path.clone()) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(top.join(path))
            && meta.is_file()
        {
            text.push_str(&format!("{} {path}\n", meta.len()));
        }
    }
    if text.is_empty() {
        return Ok(());
    }
    append(&file, &text)
}

/// The bytes of the distinct files read in the clone at `git_dir`.
pub fn read_bytes(git_dir: &Path) -> Result<u64> {
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for line in lines(&git_dir.join("yoneda").join(READ_BYTES))? {
        if let Some((size, path)) = line.split_once(' ')
            && let Ok(size) = size.parse::<u64>()
            && seen.insert(path.to_owned())
        {
            total += size;
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tallies_fetched_objects_and_read_files_across_writers() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let git_dir = dir.path().join(".git");
        let git = Git::with_git_dir(dir.path(), &git_dir);
        count_fetched(
            &git,
            &[
                (ObjectKind::Commit, &b"c".repeat(10)),
                (ObjectKind::Tree, &b"t".repeat(7)),
                (ObjectKind::Tree, &b"t".repeat(3)),
            ],
        )?;
        count_fetched(&git, &[(ObjectKind::Blob, &b"b".repeat(100))])?;
        count_fetched(&git, &[])?;
        // A torn line from a writer killed mid-append is not counted.
        append(&git_dir.join("yoneda").join(FETCHED), "blob 9")?;
        assert_eq!(
            fetched(&git_dir)?,
            Fetched {
                objects: 4,
                bytes: 120,
                blobs: 1,
                blob_bytes: 100
            }
        );
        // Without an explicit repository (an offline checkout) nothing is tallied.
        count_fetched(&Git::new(dir.path()), &[(ObjectKind::Blob, b"x")])?;
        assert_eq!(fetched(&git_dir)?.objects, 4);

        std::fs::create_dir_all(dir.path().join("src")).context("mkdir")?;
        std::fs::write(dir.path().join("src/a.rs"), "12345").context("write")?;
        std::fs::write(dir.path().join("b.txt"), "123").context("write")?;
        let read =
            |paths: &[&str]| -> Vec<String> { paths.iter().map(|p| (*p).to_owned()).collect() };
        note_reads(
            &git_dir,
            dir.path(),
            &read(&["src/a.rs", "src", "gone.txt"]),
        )?;
        // A file read again counts once, at the size it had when first read.
        std::fs::write(dir.path().join("src/a.rs"), "1234567890").context("write")?;
        note_reads(&git_dir, dir.path(), &read(&["src/a.rs", "b.txt"]))?;
        assert_eq!(read_bytes(&git_dir)?, 8);
        assert_eq!(read_bytes(&dir.path().join("elsewhere"))?, 0);
        Ok(())
    }
}
