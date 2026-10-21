//! Filesystem-facing projection of the server-authoritative source API.
use std::sync::atomic::{AtomicBool, Ordering};
use yoneda_agents_core::{Error, Result};

pub const SOURCE_READ_MAX: usize = 64 * 1024;
pub const SOURCE_CACHE_MAX: usize = 8 * 1024 * 1024;
pub const SOURCE_FILE_MAX: u64 = yoneda_agents_core::source_workspace::MAX_FILE_BYTES;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceNode {
    pub path: String,
    pub version: u64,
    pub mode: u32,
    pub size: u64,
}
impl SourceNode {
    pub fn directory(&self) -> bool {
        self.mode == 0o040755
    }
    pub fn validate(&self) -> Result<()> {
        validate_path(&self.path, self.directory())?;
        if ![0o100644, 0o100755, 0o040755].contains(&self.mode)
            || self.size > SOURCE_FILE_MAX
            || self.directory() && self.size != 0
        {
            return Err(failure("INVALID_SOURCE", "Source metadata is invalid"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct SourceSlice {
    pub version: u64,
    pub offset: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug)]
pub enum SourceChange {
    Write {
        path: String,
        expected: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
    Create {
        path: String,
        mode: u32,
    },
    Truncate {
        path: String,
        expected: u64,
        size: u64,
    },
    Mode {
        path: String,
        expected: u64,
        mode: u32,
    },
    Delete {
        path: String,
        expected: u64,
    },
    Rename {
        path: String,
        expected: u64,
        target: String,
        target_expected: Option<u64>,
    },
}
impl SourceChange {
    pub fn path(&self) -> &str {
        match self {
            Self::Write { path, .. }
            | Self::Create { path, .. }
            | Self::Truncate { path, .. }
            | Self::Mode { path, .. }
            | Self::Delete { path, .. }
            | Self::Rename { path, .. } => path,
        }
    }
}

/// These methods carry no repository, job, epoch, key, or arbitrary object selector.
/// The Worker obtains attempt authority from its container context.
pub trait SourceBackend: Send + Sync {
    fn stat(&self, path: &str) -> Result<SourceNode>;
    fn list(&self, path: &str) -> Result<Vec<SourceNode>>;
    fn read(&self, path: &str, version: u64, offset: u64, length: usize) -> Result<SourceSlice>;
    fn apply(&self, request_id: &str, change: &SourceChange) -> Result<Option<SourceNode>>;
}

#[derive(Default)]
pub struct SourceCancellation(AtomicBool);
impl SourceCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<()> {
        if self.0.load(Ordering::Acquire) {
            Err(failure("SOURCE_CANCELLED", "Source attempt was cancelled"))
        } else {
            Ok(())
        }
    }
}

pub fn validate_path(path: &str, root: bool) -> Result<()> {
    if path.is_empty() && root {
        return Ok(());
    }
    yoneda_agents_core::validate_path(path)?;
    if path.len() > 512 || path.contains(':') || path.contains('\\') {
        return Err(failure("INVALID_SOURCE", "Invalid source path"));
    }
    Ok(())
}
pub fn failure(code: &str, message: &str) -> Error {
    Error::new(code, message)
}
/// A failure's message for operator logs: one line, at most 300 characters. Messages are
/// built by the runtime or returned by the Worker broker; neither carries payloads or keys.
/// Lives here because the FUSE layer and its standalone test crate include this module.
pub fn failure_detail(error: &Error) -> String {
    error
        .message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(300)
        .collect()
}
/// A local filesystem failure with its OS cause (for example a FUSE operation's EIO).
pub fn io_failure(context: &str, error: &std::io::Error) -> Error {
    Error::new("SOURCE_IO", format!("{context}: {error}"))
}
