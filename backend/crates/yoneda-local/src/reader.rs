//! One long-lived `git cat-file --batch-command` per store, shared under a lock, so a read
//! costs a pipe round trip rather than a Git process start (docs/local-landing-budget.md).
//! Git looks a missing object up again after rescanning the store's packs, so objects
//! written after the reader started are found. A broken reader is dropped and the read
//! retried once on a new one. `YONEDA_LOCAL_READER=spawn` turns it off: each read then
//! starts its own process, as before.
use crate::layout::local_error;
use crate::store::git_bin;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use yoneda_core::{Result, git_object::ObjectId};

/// What the reader answers for one id: its type name and, for `contents`, its bytes.
pub type Found = Option<(String, Option<Vec<u8>>)>;

pub struct Reader {
    store: PathBuf,
    live: Mutex<Option<Batch>>,
}

struct Batch {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl std::fmt::Debug for Reader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Reader")
            .field("store", &self.store)
            .finish()
    }
}

impl Drop for Batch {
    fn drop(&mut self) {
        // Its own child: closing stdin ends it; the handle reaps it.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Whether the long-lived reader is on (the default).
pub fn on() -> bool {
    std::env::var("YONEDA_LOCAL_READER").as_deref() != Ok("spawn")
}

impl Reader {
    pub fn new(store: &Path) -> Self {
        Self {
            store: store.to_owned(),
            live: Mutex::new(None),
        }
    }

    /// `contents` (type and bytes) or `info` (type only) for each id, in order.
    pub fn ask(&self, ids: &[ObjectId], contents: bool) -> Result<Vec<Found>> {
        let mut live = self.live.lock().unwrap_or_else(|e| e.into_inner());
        for attempt in 0..2 {
            if live.is_none() {
                *live = Some(self.start()?);
            }
            let Some(batch) = live.as_mut() else { continue };
            match batch.ask(ids, contents) {
                Ok(found) => return Ok(found),
                Err(e) if attempt == 0 => {
                    eprintln!("yoneda-local: object reader restarted: {}", e.message);
                    *live = None;
                }
                Err(e) => return Err(e),
            }
        }
        Err(local_error("The object reader stopped"))
    }

    fn start(&self) -> Result<Batch> {
        let mut child = Command::new(git_bin())
            .arg("--git-dir")
            .arg(&self.store)
            .args(["cat-file", "--batch-command"])
            .current_dir(&self.store)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| local_error(format!("Cannot start the object reader: {e}")))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| local_error("No reader input"))?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| local_error("No reader output"))?;
        Ok(Batch {
            child,
            input,
            output: BufReader::new(output),
        })
    }
}

impl Batch {
    fn ask(&mut self, ids: &[ObjectId], contents: bool) -> Result<Vec<Found>> {
        let broken = |e: std::io::Error| local_error(format!("Object reader: {e}"));
        let verb = if contents { "contents" } else { "info" };
        // Without --buffer each command is answered as soon as it is read, so the
        // commands can be written in one go and the answers read after.
        let commands: String = ids.iter().map(|id| format!("{verb} {id}\n")).collect();
        self.input.write_all(commands.as_bytes()).map_err(broken)?;
        self.input.flush().map_err(broken)?;
        let mut found = Vec::with_capacity(ids.len());
        for id in ids {
            let mut header = String::new();
            if self.output.read_line(&mut header).map_err(broken)? == 0 {
                return Err(local_error("Object reader ended"));
            }
            let parts: Vec<&str> = header.trim_end().split(' ').collect();
            if parts.get(1) == Some(&"missing") || parts.len() != 3 {
                found.push(None);
                continue;
            }
            if parts[0] != id.hex() {
                return Err(local_error("Object reader answered out of order"));
            }
            let kind = parts[1].to_owned();
            if !contents {
                found.push(Some((kind, None)));
                continue;
            }
            let size: usize = parts[2]
                .parse()
                .map_err(|_| local_error("Bad object size"))?;
            let mut data = vec![0; size + 1];
            self.output.read_exact(&mut data).map_err(broken)?;
            data.pop();
            found.push(Some((kind, Some(data))));
        }
        Ok(found)
    }
}
