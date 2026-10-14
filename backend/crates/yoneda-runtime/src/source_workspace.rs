//! Coherent source operations: server CAS is the only write authority.
#[path = "source_workspace_cache.rs"]
mod cache;
use crate::source_client::{
    SOURCE_CACHE_MAX, SOURCE_FILE_MAX, SOURCE_READ_MAX, SourceBackend, SourceCancellation,
    SourceChange, SourceNode, failure, validate_path,
};
use cache::{Cache, Key};
use std::sync::{Arc, Mutex};
use yoneda_core::Result;

pub struct SourceWorkspace {
    backend: Arc<dyn SourceBackend>,
    cache: Mutex<Cache>,
    mutations: Mutex<()>,
    cancellation: Arc<SourceCancellation>,
    read_only: bool,
}
impl SourceWorkspace {
    pub fn new(
        backend: Arc<dyn SourceBackend>,
        read_only: bool,
        metadata_ready: bool,
        cancellation: Arc<SourceCancellation>,
        cache_bytes: usize,
    ) -> Result<Self> {
        if !metadata_ready {
            return Err(failure("SOURCE_INDEX_PENDING", "Source index is not ready"));
        }
        if cache_bytes > SOURCE_CACHE_MAX {
            return Err(failure("SOURCE_LIMIT", "Source cache exceeds its limit"));
        }
        let instance = Self {
            backend,
            cache: Mutex::new(Cache::new(cache_bytes)),
            mutations: Mutex::new(()),
            cancellation,
            read_only,
        };
        let root = instance.stat("")?;
        if !root.directory() {
            return Err(failure("INVALID_SOURCE", "Source root is not a directory"));
        }
        Ok(instance)
    }
    pub fn read_only(&self) -> bool {
        self.read_only
    }
    pub fn stat(&self, path: &str) -> Result<SourceNode> {
        self.cancellation.check()?;
        validate_path(path, true)?;
        let node = self.backend.stat(path)?;
        self.cancellation.check()?;
        node.validate()?;
        if node.path != path {
            return Err(failure("SOURCE_FENCED", "Source path changed"));
        }
        Ok(node)
    }
    pub fn list(&self, path: &str) -> Result<Vec<SourceNode>> {
        if !self.stat(path)?.directory() {
            return Err(failure("SOURCE_NOT_DIRECTORY", "Not a source directory"));
        }
        let entries = self.backend.list(path)?;
        self.cancellation.check()?;
        if entries.len() > 10_000 {
            return Err(failure("SOURCE_LIMIT", "Directory exceeds source limits"));
        }
        let mut names = std::collections::BTreeSet::new();
        for entry in &entries {
            entry.validate()?;
            let parent = entry.path.rsplit_once('/').map_or("", |(parent, _)| parent);
            if entry.path.is_empty() || parent != path || !names.insert(entry.path.clone()) {
                return Err(failure(
                    "SOURCE_FENCED",
                    "Source directory metadata changed",
                ));
            }
        }
        Ok(entries)
    }
    pub fn read(&self, path: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
        if length > SOURCE_READ_MAX {
            return Err(failure("SOURCE_LIMIT", "Source read exceeds its limit"));
        }
        let node = self.stat(path)?;
        if node.directory() {
            return Err(failure("SOURCE_IS_DIRECTORY", "Cannot read a directory"));
        }
        if offset >= node.size || length == 0 {
            return Ok(Vec::new());
        }
        let length = length.min(
            usize::try_from(node.size - offset)
                .map_err(|_| failure("SOURCE_LIMIT", "Source size overflow"))?,
        );
        let key = Key {
            path: path.into(),
            version: node.version,
            offset,
            length,
        };
        if let Some(bytes) = self
            .cache
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source cache lock failed"))?
            .get(&key)
        {
            return Ok(bytes);
        }
        let slice = self.backend.read(path, node.version, offset, length)?;
        self.cancellation.check()?;
        if slice.version != node.version || slice.offset != offset || slice.bytes.len() != length {
            return Err(failure(
                "SOURCE_FENCED",
                "Source read version or range changed",
            ));
        }
        self.cache
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source cache lock failed"))?
            .put(key, slice.bytes.clone());
        Ok(slice.bytes)
    }
    /// Acknowledgment follows the server operation; no independent dirty overlay exists.
    pub fn apply(&self, request_id: &str, change: &SourceChange) -> Result<Option<SourceNode>> {
        self.cancellation.check()?;
        if self.read_only {
            return Err(failure("SOURCE_READ_ONLY", "Source mount is read-only"));
        }
        validate_path(change.path(), false)?;
        if request_id.is_empty() || request_id.len() > 160 {
            return Err(failure("INVALID_SOURCE", "Invalid source request ID"));
        }
        let _serial = self
            .mutations
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source mutation lock failed"))?;
        match change {
            SourceChange::Write { offset, bytes, .. } => {
                if bytes.len() > SOURCE_READ_MAX
                    || offset
                        .checked_add(bytes.len() as u64)
                        .is_none_or(|end| end > SOURCE_FILE_MAX)
                {
                    return Err(failure("SOURCE_LIMIT", "Source write exceeds its limit"));
                }
            }
            SourceChange::Truncate { size, .. } if *size > SOURCE_FILE_MAX => {
                return Err(failure("SOURCE_LIMIT", "Source size exceeds its limit"));
            }
            SourceChange::Create { mode, .. } | SourceChange::Mode { mode, .. }
                if ![0o100644, 0o100755, 0o040755].contains(mode) =>
            {
                return Err(failure("INVALID_SOURCE", "Unsupported source mode"));
            }
            SourceChange::Rename { target, .. } => validate_path(target, false)?,
            _ => {}
        }
        let node = self.backend.apply(request_id, change)?;
        self.cancellation.check()?;
        self.invalidate(change.path())?;
        if let SourceChange::Rename { target, .. } = change {
            self.invalidate(target)?;
        }
        if let Some(node) = &node {
            node.validate()?;
            let expected_path = if let SourceChange::Rename { target, .. } = change {
                target.as_str()
            } else {
                change.path()
            };
            if node.path != expected_path || node.directory() {
                return Err(failure(
                    "SOURCE_FENCED",
                    "Source mutation receipt changed its path or kind",
                ));
            }
        }
        Ok(node)
    }
    pub fn invalidate(&self, path: &str) -> Result<()> {
        self.cache
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source cache lock failed"))?
            .invalidate(path);
        Ok(())
    }
    pub fn cancel(&self) -> Result<()> {
        self.cancellation.cancel();
        self.cache
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source cache lock failed"))?
            .clear();
        Ok(())
    }
}
