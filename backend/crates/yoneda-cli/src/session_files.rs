//! A coding session's local record, under `$GIT_DIR/yoneda/` so it is never committed:
//! - `reads`: the repo-relative files read since the last push (agent hooks or `yoneda
//!   reads add`), one per line. A push declares them as its read set and clears them.
//! - `pushed`: the commits pushed since the last session record, one `<commit> <reads
//!   digest>` per line. The agent's turn-end hook posts a session record for each.
use crate::error::{Context, Result};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The platform's caps on one push's declared reads (`platform_push_reads`).
pub const MAX_READS: usize = 2_000;
pub const MAX_READ_BYTES: usize = 64 * 1024;
/// One `-o` value stays well inside a pkt-line (65516 bytes).
const OPTION_BYTES: usize = 32 * 1024;

pub struct SessionFiles {
    dir: PathBuf,
}

impl SessionFiles {
    pub fn new(git_dir: &Path) -> Self {
        Self {
            dir: git_dir.join("yoneda"),
        }
    }

    fn lines(&self, name: &str) -> Result<Vec<String>> {
        match std::fs::read_to_string(self.dir.join(name)) {
            Ok(text) => Ok(text
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e).context(format!("reading {}", self.dir.join(name).display())),
        }
    }

    fn append(&self, name: &str, lines: &[String]) -> Result<()> {
        if lines.is_empty() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir).context(format!("creating {}", self.dir.display()))?;
        let path = self.dir.join(name);
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .context(format!("opening {}", path.display()))?;
        // One write per call: concurrent hooks append whole lines.
        file.write_all(format!("{}\n", lines.join("\n")).as_bytes())
            .context(format!("writing {}", path.display()))
    }

    fn remove(&self, name: &str) -> Result<()> {
        match std::fs::remove_file(self.dir.join(name)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                Err(e).context(format!("removing {}", self.dir.join(name).display()))
            }
            _ => Ok(()),
        }
    }

    /// The declared reads, sorted and without duplicates.
    pub fn reads(&self) -> Result<Vec<String>> {
        Ok(self
            .lines("reads")?
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect())
    }

    /// Adds `paths` (repo-relative) not declared yet; returns how many were new.
    pub fn add_reads(&self, paths: &[String]) -> Result<usize> {
        let held: BTreeSet<String> = self.lines("reads")?.into_iter().collect();
        let new: BTreeSet<String> = paths
            .iter()
            .filter(|p| !p.is_empty() && !held.contains(*p))
            .cloned()
            .collect();
        let new: Vec<String> = new.into_iter().collect();
        self.append("reads", &new)?;
        Ok(new.len())
    }

    pub fn clear_reads(&self) -> Result<()> {
        self.remove("reads")
    }

    /// Notes `commits` as pushed with `reads` declared.
    pub fn note_pushed(&self, commits: &[String], reads: &[String]) -> Result<()> {
        let digest = reads_digest(reads);
        let lines: Vec<String> = commits.iter().map(|c| format!("{c} {digest}")).collect();
        self.append("pushed", &lines)
    }

    /// The pushed commits not recorded yet (`(commit, reads digest)`), removed from the
    /// file: a session record is posted at most once per push.
    pub fn take_pushed(&self) -> Result<Vec<(String, String)>> {
        let lines = self.lines("pushed")?;
        self.remove("pushed")?;
        let mut seen = BTreeSet::new();
        Ok(lines
            .into_iter()
            .filter_map(|l| {
                let (commit, digest) = l.split_once(' ').unwrap_or((&l, ""));
                seen.insert(commit.to_owned())
                    .then(|| (commit.to_owned(), digest.to_owned()))
            })
            .collect())
    }
}

/// The digest a session record names its read set by: SHA-256 of the sorted paths, one
/// per line.
pub fn reads_digest(reads: &[String]) -> String {
    let sorted: BTreeSet<&String> = reads.iter().collect();
    let text: Vec<&str> = sorted.into_iter().map(String::as_str).collect();
    yoneda_core::digest(text.join("\n").as_bytes())
}

/// `-o` values declaring `reads` (`yoneda.reads=a,b,…`, split to fit a pkt-line).
/// A path holding a comma cannot be declared this way and is refused.
pub fn push_options(reads: &[String]) -> std::result::Result<Vec<String>, String> {
    let bytes: usize = reads.iter().map(String::len).sum();
    if reads.len() > MAX_READS || bytes > MAX_READ_BYTES {
        return Err(format!(
            "{} declared reads exceed the platform's {MAX_READS} paths / {} KiB per push: `yoneda reads clear`, then `yoneda reads add <dir>/` for what you rely on",
            reads.len(),
            MAX_READ_BYTES / 1024
        ));
    }
    if let Some(bad) = reads.iter().find(|r| r.contains(',')) {
        return Err(format!("{bad:?} holds a comma and cannot be declared"));
    }
    let mut options = Vec::new();
    let mut current = String::new();
    for read in reads {
        if !current.is_empty() && current.len() + read.len() + 1 > OPTION_BYTES {
            options.push(format!("yoneda.reads={current}"));
            current.clear();
        }
        if !current.is_empty() {
            current.push(',');
        }
        current.push_str(read);
    }
    if !current.is_empty() {
        options.push(format!("yoneda.reads={current}"));
    }
    Ok(options)
}

/// The read set the helper's `option push-option` values declare.
pub fn reads_from_options(options: &[String]) -> Vec<String> {
    options
        .iter()
        .filter_map(|o| o.strip_prefix("yoneda.reads="))
        .flat_map(|paths| paths.split(','))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn reads_accumulate_once_and_clear_after_a_push() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let files = SessionFiles::new(dir.path());
        assert!(files.reads()?.is_empty());
        assert_eq!(files.add_reads(&strings(&["b.rs", "a.rs", "b.rs"]))?, 2);
        assert_eq!(files.add_reads(&strings(&["a.rs", "c.rs"]))?, 1);
        assert_eq!(files.reads()?, ["a.rs", "b.rs", "c.rs"]);
        files.note_pushed(&strings(&["c1", "c2"]), &files.reads()?)?;
        files.clear_reads()?;
        assert!(files.reads()?.is_empty());
        let pushed = files.take_pushed()?;
        assert_eq!(pushed.len(), 2);
        assert_eq!(
            pushed[0].1,
            reads_digest(&strings(&["c.rs", "a.rs", "b.rs"]))
        );
        assert!(files.take_pushed()?.is_empty());
        Ok(())
    }

    #[test]
    fn options_split_to_fit_and_refuse_what_the_platform_would() {
        assert_eq!(
            push_options(&strings(&["a", "src/"])).ok(),
            Some(strings(&["yoneda.reads=a,src/"]))
        );
        let many: Vec<String> = (0..1400).map(|i| format!("dir/{i:040}")).collect();
        let options = push_options(&many).unwrap_or_default();
        assert!(options.len() > 1 && options.iter().all(|o| o.len() <= OPTION_BYTES + 13));
        assert_eq!(reads_from_options(&options), many);
        assert!(push_options(&strings(&["a,b"])).is_err());
        let over: Vec<String> = (0..=MAX_READS).map(|i| i.to_string()).collect();
        assert!(push_options(&over).is_err());
        assert!(push_options(&[]).unwrap_or_default().is_empty());
    }
}
