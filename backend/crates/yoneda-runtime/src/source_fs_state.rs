//! Inode/handle bookkeeping for a server-authoritative FUSE mount.
use crate::{
    source_client::{SourceChange, SourceNode, failure, validate_path},
    source_workspace::SourceWorkspace,
};
use fuser::{Errno, FileAttr, FileHandle, FileType, INodeNo, Notifier};
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, UNIX_EPOCH},
};
use yoneda_agents_core::{Error, Result};

#[derive(Clone)]
pub(super) struct Handle {
    pub path: String,
    pub version: u64,
    pub writable: bool,
}
pub(super) struct FsState {
    pub source: Arc<SourceWorkspace>,
    pub directories: crate::source_workspace_directories::LocalDirectories,
    pub paths: Mutex<BTreeMap<INodeNo, String>>,
    pub handles: Mutex<BTreeMap<FileHandle, Handle>>,
    pub notifier: Mutex<Option<Notifier>>,
    next_inode: AtomicU64,
    next_handle: AtomicU64,
    request: AtomicU64,
    request_prefix: String,
}
impl FsState {
    pub fn new(source: Arc<SourceWorkspace>) -> Result<Self> {
        let mut random = [0_u8; 16];
        use std::io::Read;
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut random))
            .map_err(|_| failure("SOURCE_ENTROPY", "Source request identity unavailable"))?;
        Ok(Self {
            directories: crate::source_workspace_directories::LocalDirectories::new(source.clone()),
            source,
            paths: Mutex::new(BTreeMap::from([(INodeNo(1), String::new())])),
            handles: Mutex::new(BTreeMap::new()),
            notifier: Mutex::new(None),
            next_inode: AtomicU64::new(2),
            next_handle: AtomicU64::new(1),
            request: AtomicU64::new(1),
            request_prefix: random.iter().map(|byte| format!("{byte:02x}")).collect(),
        })
    }
    pub fn id(&self) -> String {
        format!(
            "fs-{}-{}",
            self.request_prefix,
            self.request.fetch_add(1, Ordering::Relaxed)
        )
    }
    pub fn inode(&self, path: &str) -> Result<INodeNo> {
        let mut paths = self
            .paths
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source inode lock failed"))?;
        if let Some((inode, _)) = paths
            .iter()
            .find(|(_, candidate)| candidate.as_str() == path)
        {
            return Ok(*inode);
        }
        if paths.len() >= 20_001 {
            return Err(failure("SOURCE_LIMIT", "Source inode limit exceeded"));
        }
        let inode = INodeNo(self.next_inode.fetch_add(1, Ordering::Relaxed));
        paths.insert(inode, path.into());
        Ok(inode)
    }
    pub fn path(&self, inode: INodeNo) -> Result<String> {
        self.paths
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source inode lock failed"))?
            .get(&inode)
            .cloned()
            .ok_or_else(|| failure("SOURCE_NOT_FOUND", "Unknown source inode"))
    }
    pub fn child(&self, parent: INodeNo, name: &OsStr) -> Result<String> {
        let name = name
            .to_str()
            .ok_or_else(|| failure("INVALID_SOURCE", "Non-UTF8 source path"))?;
        if name.contains('/') || name.is_empty() {
            return Err(failure("INVALID_SOURCE", "Invalid source filename"));
        }
        let parent = self.path(parent)?;
        let path = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        };
        validate_path(&path, false)?;
        Ok(path)
    }
    pub fn attr(&self, node: &SourceNode) -> Result<FileAttr> {
        let stamp = UNIX_EPOCH + Duration::from_secs(node.version);
        Ok(FileAttr {
            ino: self.inode(&node.path)?,
            size: node.size,
            blocks: node.size.div_ceil(512),
            atime: stamp,
            mtime: stamp,
            ctime: stamp,
            crtime: stamp,
            kind: if node.directory() {
                FileType::Directory
            } else {
                FileType::RegularFile
            },
            perm: (node.mode & 0o777) as u16,
            nlink: if node.directory() { 2 } else { 1 },
            uid: 1000,
            gid: 1000,
            rdev: 0,
            blksize: 65536,
            flags: 0,
        })
    }
    pub fn open(&self, node: &SourceNode, writable: bool) -> Result<FileHandle> {
        if writable && self.source.read_only() {
            return Err(failure("SOURCE_READ_ONLY", "Source mount is read-only"));
        }
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source handle lock failed"))?;
        if handles.len() >= 1024 {
            return Err(failure("SOURCE_LIMIT", "Source handle limit exceeded"));
        }
        let handle = FileHandle(self.next_handle.fetch_add(1, Ordering::Relaxed));
        handles.insert(
            handle,
            Handle {
                path: node.path.clone(),
                version: node.version,
                writable,
            },
        );
        Ok(handle)
    }
    pub fn handle(&self, handle: FileHandle) -> Result<Handle> {
        self.handles
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source handle lock failed"))?
            .get(&handle)
            .cloned()
            .ok_or_else(|| failure("SOURCE_NOT_FOUND", "Unknown source handle"))
    }
    pub fn apply(&self, change: &SourceChange) -> Result<Option<SourceNode>> {
        let result = self.source.apply(&self.id(), change)?;
        if let Some(node) = &result {
            let expected = match change {
                SourceChange::Create { .. } => None,
                SourceChange::Write { expected, .. }
                | SourceChange::Truncate { expected, .. }
                | SourceChange::Mode { expected, .. }
                | SourceChange::Delete { expected, .. }
                | SourceChange::Rename { expected, .. } => Some(*expected),
            };
            for handle in self
                .handles
                .lock()
                .map_err(|_| failure("SOURCE_LOCK", "Source handle lock failed"))?
                .values_mut()
            {
                if handle.path == change.path() && Some(handle.version) == expected {
                    handle.version = node.version;
                }
            }
        }
        Ok(result)
    }
    pub fn update_handle(&self, handle: FileHandle, node: &SourceNode) -> Result<()> {
        let mut handles = self
            .handles
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source handle lock failed"))?;
        let value = handles
            .get_mut(&handle)
            .ok_or_else(|| failure("SOURCE_NOT_FOUND", "Unknown source handle"))?;
        value.version = node.version;
        Ok(())
    }
    pub fn rename(&self, from: &str, to: &str) -> Result<()> {
        let mut paths = self
            .paths
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source inode lock failed"))?;
        paths.retain(|_, path| path != to);
        for path in paths.values_mut() {
            if path == from {
                *path = to.into();
            }
        }
        for handle in self
            .handles
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source handle lock failed"))?
            .values_mut()
        {
            if handle.path == from {
                handle.path = to.into();
            }
        }
        Ok(())
    }
    pub fn invalidate(&self, paths: &[String]) -> Result<()> {
        for path in paths {
            self.source.invalidate(path)?;
            if let Some(notifier) = self
                .notifier
                .lock()
                .map_err(|_| failure("SOURCE_LOCK", "Source notifier lock failed"))?
                .as_ref()
            {
                let inode = self.inode(path)?;
                notifier.inval_inode(inode, 0, 0).map_err(|_| {
                    failure("SOURCE_INVALIDATION", "Source kernel invalidation failed")
                })?;
                if let Some((parent, name)) = path.rsplit_once('/') {
                    notifier
                        .inval_entry(self.inode(parent)?, OsStr::new(name))
                        .map_err(|_| {
                            failure("SOURCE_INVALIDATION", "Source entry invalidation failed")
                        })?;
                } else if !path.is_empty() {
                    notifier
                        .inval_entry(INodeNo(1), OsStr::new(path))
                        .map_err(|_| {
                            failure("SOURCE_INVALIDATION", "Source entry invalidation failed")
                        })?;
                }
            }
        }
        Ok(())
    }
}
pub(super) fn errno(error: Error) -> Errno {
    match error.code.as_str() {
        "SOURCE_NOT_FOUND" | "NOT_FOUND" => Errno::ENOENT,
        "SOURCE_READ_ONLY" | "FORBIDDEN" => Errno::EROFS,
        "SOURCE_CANCELLED" => Errno::ECANCELED,
        "SOURCE_CAS" | "FILE_VERSION_CONFLICT" | "VERSION_CONFLICT" | "SOURCE_FENCED" => {
            Errno::ESTALE
        }
        "SOURCE_IS_DIRECTORY" => Errno::EISDIR,
        "SOURCE_NOT_DIRECTORY" => Errno::ENOTDIR,
        "SOURCE_NOT_EMPTY" => Errno::ENOTEMPTY,
        "SOURCE_UNSUPPORTED" => Errno::ENOTSUP,
        "ALREADY_EXISTS" => Errno::EEXIST,
        "INVALID_SOURCE" | "PATH" | "INVALID_INPUT" => Errno::EINVAL,
        "SOURCE_LIMIT" | "RESOURCE_LIMIT" => Errno::EFBIG,
        _ => Errno::EIO,
    }
}
