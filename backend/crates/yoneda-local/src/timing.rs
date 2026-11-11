//! Per-push timings, behind a switch: with `YONEDA_LOCAL_TIMINGS=<file>` the service appends
//! one JSON line per ref a push named, with its own milliseconds per phase, so local write
//! speed is measured at the service, apart from Git's client and from cloud sync (which
//! runs on its own thread). Unset, nothing is measured or written.
//!
//! `{ref, outcome, start_ms, ms: {store, land, merge?, checks?, project, total}}`: `store`
//! is verifying the pack, writing its objects and recording its commits (shared by every
//! ref of the push); `land` is this ref's move, including waiting for the branch's landing
//! lock, its merge and its checks; `outcome` is `landed`, `merged` or `refused`.
use serde_json::{Map, Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Where timings go (none: switched off), read once when the service opens.
pub struct Timings {
    file: Option<PathBuf>,
    writing: Mutex<()>,
}

impl Timings {
    pub fn from_env() -> Self {
        Self {
            file: std::env::var_os("YONEDA_LOCAL_TIMINGS")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            writing: Mutex::new(()),
        }
    }

    pub fn on(&self) -> bool {
        self.file.is_some()
    }

    /// Appends `lines`; a failed write only loses the measurement.
    pub fn write(&self, lines: &[Value]) {
        let Some(path) = &self.file else { return };
        let _held = self.writing.lock().unwrap_or_else(|e| e.into_inner());
        let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        else {
            return;
        };
        for line in lines {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// One phase clock; `ms` is the time since it started.
pub struct Clock(Instant);

impl Clock {
    pub fn start() -> Self {
        Self(Instant::now())
    }
    pub fn ms(&self) -> u64 {
        u64::try_from(self.0.elapsed().as_millis()).unwrap_or(u64::MAX)
    }
}

/// Wall-clock milliseconds, so pushes can be lined up against each other.
pub fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// The phases one ref's move adds (`merge`, `checks`), and whether it merged.
#[derive(Default)]
pub struct Phases {
    pub ms: Map<String, Value>,
    pub merged: bool,
}

impl Phases {
    pub fn add(&mut self, name: &str, ms: u64) {
        let had = self.ms.get(name).and_then(Value::as_u64).unwrap_or(0);
        self.ms.insert(name.into(), json!(had + ms));
    }
}
