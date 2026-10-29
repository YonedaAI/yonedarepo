//! A coding session's local record, under `$GIT_DIR/yoneda/` so it is never committed:
//! - `reads`: the repo-relative files read since the last push (agent hooks or `yoneda
//!   reads add`), one per line. A push declares them as its read set and clears them.
//! - `pushed`: the commits pushed whose session record is not posted yet, one `<commit>
//!   <reads digest, or - when none were declared> [<session id>]` per line. The agent's
//!   turn-end hook posts a session record for each of its own session's (and for
//!   unattributed ones), and only then removes the line.
//! - `context-<digest>`: the context packet a session started with (`yoneda context`, which
//!   the start hooks inject), one file per session, kept for its transcript.
//! - `memory-<digest>`: present when a session added a memory since its last turn ended
//!   (`yoneda memory add`, or the agent hooks seeing the MCP tool), so the turn-end hook
//!   offers the session's summary as a draft memory.
//!
//! The session id comes from the agent's environment: `YONEDA_SESSION_ID` (the Claude
//! Code plugin exports it at session start), else opencode's `OPENCODE_SESSION_ID`, which
//! opencode sets for every shell command a session runs.
use crate::error::{Context, Result};
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The platform's caps on one push's declared reads (`platform_push_reads`).
pub const MAX_READS: usize = 2_000;
pub const MAX_READ_BYTES: usize = 64 * 1024;
/// One `-o` value stays well inside a pkt-line (65516 bytes).
const OPTION_BYTES: usize = 32 * 1024;

/// The coding session this process runs for, from its environment.
pub fn current_session() -> Option<String> {
    let var = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty() && !v.contains(char::is_whitespace))
    };
    var("YONEDA_SESSION_ID")
        .or_else(|| var("OPENCODE_SESSION_ID").map(|id| format!("opencode:{id}")))
}

/// A pushed commit waiting for its session record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pushed {
    pub commit: String,
    /// The declared reads' digest, when the push declared any.
    pub reads: Option<String>,
    pub session: Option<String>,
}

impl Pushed {
    fn parse(line: &str) -> Self {
        let mut words = line.split_whitespace();
        let commit = words.next().unwrap_or_default().to_owned();
        let reads = words
            .next()
            .filter(|d| *d != "-" && !d.is_empty())
            .map(str::to_owned);
        let session = words.next().map(str::to_owned);
        Self {
            commit,
            reads,
            session,
        }
    }

    fn line(&self) -> String {
        let mut line = format!("{} {}", self.commit, self.reads.as_deref().unwrap_or("-"));
        if let Some(session) = &self.session {
            line.push(' ');
            line.push_str(session);
        }
        line
    }
}

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

    /// The file holding `session`'s context packet (named by a digest: ids hold `:`).
    fn context_file(&self, session: &str) -> PathBuf {
        let digest = yoneda_core::digest(session.as_bytes());
        self.dir.join(format!("context-{}", &digest[..16]))
    }

    /// Keeps the context packet `session` started with (replacing an earlier one: a resumed
    /// or compacted session starts again with fresh context).
    pub fn save_context(&self, session: &str, text: &str) -> Result<()> {
        std::fs::create_dir_all(&self.dir).context(format!("creating {}", self.dir.display()))?;
        let path = self.context_file(session);
        std::fs::write(&path, text).context(format!("writing {}", path.display()))
    }

    /// The context packet `session` started with, when one was kept.
    pub fn context(&self, session: &str) -> Option<String> {
        std::fs::read_to_string(self.context_file(session)).ok()
    }

    fn memory_file(&self, session: &str) -> PathBuf {
        let digest = yoneda_core::digest(session.as_bytes());
        self.dir.join(format!("memory-{}", &digest[..16]))
    }

    /// Notes that `session` added a memory.
    pub fn note_memory_added(&self, session: &str) -> Result<()> {
        std::fs::create_dir_all(&self.dir).context(format!("creating {}", self.dir.display()))?;
        let path = self.memory_file(session);
        std::fs::write(&path, b"").context(format!("writing {}", path.display()))
    }

    /// Whether `session` added a memory since this was last asked (and forgets it).
    pub fn take_memory_added(&self, session: &str) -> Result<bool> {
        match std::fs::remove_file(self.memory_file(session)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e).context("removing the memory note"),
        }
    }

    /// Notes `commits` as pushed with `reads` declared, by `session` when known.
    pub fn note_pushed(
        &self,
        commits: &[String],
        reads: &[String],
        session: Option<&str>,
    ) -> Result<()> {
        let digest = (!reads.is_empty()).then(|| reads_digest(reads));
        let lines: Vec<String> = commits
            .iter()
            .map(|c| {
                Pushed {
                    commit: c.clone(),
                    reads: digest.clone(),
                    session: session.map(str::to_owned),
                }
                .line()
            })
            .collect();
        self.append("pushed", &lines)
    }

    /// The pushed commits of `session` (and those no session claimed) whose records are not
    /// posted yet, once each; another session's are left for it. They stay noted until
    /// `forget_pushed`: a hook killed mid-post loses nothing (in the agent sandbox opencode
    /// exits, and its container stops, without waiting for every hook). Hooks running at once
    /// may both post one; the platform answers the second as already recorded.
    pub fn pending_pushed(&self, session: Option<&str>) -> Result<Vec<Pushed>> {
        let mut seen = BTreeSet::new();
        Ok(self
            .lines("pushed")?
            .iter()
            .map(|l| Pushed::parse(l))
            .filter(|p| p.session.is_none() || p.session.as_deref() == session)
            .filter(|p| !p.commit.is_empty() && seen.insert(p.commit.clone()))
            .collect())
    }

    /// Removes `commits` from the pushed notes (their records are posted, or refused for
    /// good). The file is replaced by an atomic rename, so a concurrent reader sees the old
    /// notes or the new ones, never a partial file.
    pub fn forget_pushed(&self, commits: &[String]) -> Result<()> {
        if commits.is_empty() {
            return Ok(());
        }
        let keep: Vec<String> = self
            .lines("pushed")?
            .into_iter()
            .filter(|l| !commits.contains(&Pushed::parse(l).commit))
            .collect();
        if keep.is_empty() {
            return self.remove("pushed");
        }
        // Unique per writer: per process, and per thread for in-process callers.
        let tmp = format!(
            "pushed.{}.{:?}.tmp",
            std::process::id(),
            std::thread::current().id()
        )
        .replace(['(', ')'], "");
        let tmp = self.dir.join(tmp);
        std::fs::write(&tmp, format!("{}\n", keep.join("\n")))
            .context(format!("writing {}", tmp.display()))?;
        std::fs::rename(&tmp, self.dir.join("pushed"))
            .context(format!("replacing {}", self.dir.join("pushed").display()))
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
        files.note_pushed(&strings(&["c1", "c2"]), &files.reads()?, None)?;
        files.clear_reads()?;
        assert!(files.reads()?.is_empty());
        let pushed = files.pending_pushed(None)?;
        assert_eq!(pushed.len(), 2);
        assert_eq!(
            pushed[0].reads.as_deref(),
            Some(reads_digest(&strings(&["c.rs", "a.rs", "b.rs"])).as_str())
        );
        files.forget_pushed(&strings(&["c1", "c2"]))?;
        assert!(files.pending_pushed(None)?.is_empty());
        Ok(())
    }

    #[test]
    fn each_session_takes_its_own_pushes_and_the_unclaimed() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let files = SessionFiles::new(dir.path());
        files.note_pushed(&strings(&["a1"]), &strings(&["x"]), Some("opencode:s1"))?;
        files.note_pushed(&strings(&["b1"]), &[], Some("opencode:s2"))?;
        files.note_pushed(&strings(&["u1", "a1"]), &[], None)?;
        // A line from before session ids: `<commit> <digest>`.
        files.append("pushed", &[format!("old {}", "e".repeat(64))])?;
        let mine = files.pending_pushed(Some("opencode:s1"))?;
        let commits: Vec<&str> = mine.iter().map(|p| p.commit.as_str()).collect();
        assert_eq!(commits, ["a1", "u1", "old"]);
        assert!(mine[0].reads.is_some() && mine[1].reads.is_none());
        files.forget_pushed(&strings(&["a1", "u1", "old"]))?;
        let theirs = files.pending_pushed(Some("opencode:s2"))?;
        assert_eq!(theirs.len(), 1);
        assert_eq!(theirs[0].session.as_deref(), Some("opencode:s2"));
        assert!(files.pending_pushed(Some("opencode:s1"))?.is_empty());
        Ok(())
    }

    #[test]
    fn a_hook_killed_after_taking_loses_no_push() -> Result<()> {
        // In the agent sandbox opencode exits as soon as its awaited hooks end, and the
        // container stop kills a stop hook that is still posting (L3, 2026-10-28).
        let dir = tempfile::tempdir().context("tempdir")?;
        let files = SessionFiles::new(dir.path());
        files.note_pushed(&strings(&["c1"]), &[], Some("opencode:s1"))?;
        let killed = files.pending_pushed(Some("opencode:s1"))?;
        assert_eq!(killed.len(), 1);
        // The killed hook never posted; the next pass must still see the push.
        let next = files.pending_pushed(Some("opencode:s1"))?;
        assert_eq!(
            next.iter().map(|p| p.commit.as_str()).collect::<Vec<_>>(),
            ["c1"]
        );
        Ok(())
    }

    #[test]
    fn concurrent_record_passes_each_see_the_push_and_forget_only_what_was_posted() -> Result<()> {
        // opencode 2.2 sets the plugin up twice, so two stop hooks run at the same moment.
        const PASSES: usize = 8;
        for round in 0..50 {
            let dir = tempfile::tempdir().context("tempdir")?;
            let files = SessionFiles::new(dir.path());
            files.note_pushed(&strings(&["c1"]), &[], Some("opencode:s1"))?;
            files.note_pushed(&strings(&["d1"]), &[], Some("opencode:s2"))?;
            let start = std::sync::Arc::new(std::sync::Barrier::new(PASSES));
            let passes: Vec<_> = (0..PASSES)
                .map(|_| {
                    let (path, start) = (dir.path().to_owned(), start.clone());
                    std::thread::spawn(move || -> Result<usize> {
                        start.wait();
                        let files = SessionFiles::new(&path);
                        let seen = files.pending_pushed(Some("opencode:s1"))?;
                        files.forget_pushed(&strings(&["c1"]))?;
                        Ok(seen.len())
                    })
                })
                .collect();
            for pass in passes {
                pass.join()
                    .map_err(|_| crate::error::Error::new("pass panicked"))??;
            }
            assert!(
                files.pending_pushed(Some("opencode:s1"))?.is_empty(),
                "round {round}"
            );
            let theirs = files.pending_pushed(Some("opencode:s2"))?;
            assert_eq!(
                theirs.len(),
                1,
                "round {round}: the other session's push survives"
            );
        }
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
