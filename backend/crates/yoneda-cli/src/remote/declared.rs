//! The read set a push declares: `git push -o yoneda.reads=…` plus the reads this coding
//! session recorded (`$GIT_DIR/yoneda/reads`, written by the agent hooks or `yoneda reads
//! add`). The pushed tip carries it; once every ref went through, the recorded reads are
//! cleared and the tips noted for the session record.
use super::{Session, say};
use crate::error::{Error, Result};
use crate::session_files::{MAX_READ_BYTES, MAX_READS, SessionFiles, reads_from_options};
use std::collections::BTreeSet;

pub fn reads(session: &Session) -> Result<Vec<String>> {
    let mut all: BTreeSet<String> = reads_from_options(&session.options.push_options)
        .into_iter()
        .collect();
    all.extend(SessionFiles::new(&session.git_dir).reads()?);
    let bytes: usize = all.iter().map(String::len).sum();
    if all.len() > MAX_READS || bytes > MAX_READ_BYTES {
        return Err(Error::new(format!(
            "{} declared reads exceed the platform's {MAX_READS} paths / {} KiB per push: `yoneda reads clear`, then `yoneda reads add <dir>/` for what you rely on",
            all.len(),
            MAX_READ_BYTES / 1024
        )));
    }
    Ok(all.into_iter().collect())
}

/// After a push whose every ref went through: the recorded reads are spent.
pub fn spent(session: &Session, tips: &[String], reads: &[String]) {
    let files = SessionFiles::new(&session.git_dir);
    let done = files
        .note_pushed(tips, reads)
        .and_then(|()| files.clear_reads());
    if let Err(e) = done {
        say(&format!(
            "pushed, but updating the session's reads failed: {e}"
        ));
    }
}
