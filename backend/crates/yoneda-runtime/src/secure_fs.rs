//! Descriptor-relative capture rejects symlinks in every component, even after path inspection.
use crate::err;
use std::{
    ffi::CString,
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, fs::PermissionsExt},
    },
    path::Path,
};
use yoneda_agents_core::{FileEntry, Result};

pub(crate) struct ReadFailure {
    pub(crate) error: yoneda_agents_core::Error,
    pub(crate) stage: &'static str,
    pub(crate) code: &'static str,
    pub(crate) errno: Option<i32>,
}
impl ReadFailure {
    fn io(stage: &'static str, error: std::io::Error) -> Self {
        Self {
            errno: error.raw_os_error(),
            error: err(error),
            stage,
            code: "IO",
        }
    }
    fn bounded(stage: &'static str, code: &'static str, error: impl std::fmt::Display) -> Self {
        Self {
            error: err(error),
            stage,
            code,
            errno: None,
        }
    }
}
fn open_at(
    parent: i32,
    name: &std::ffi::CStr,
    flags: i32,
    stage: &'static str,
) -> std::result::Result<OwnedFd, ReadFailure> {
    // SAFETY: name is NUL-terminated; successful openat gives this OwnedFd sole ownership.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(ReadFailure::io(stage, std::io::Error::last_os_error()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}
pub(crate) fn read_regular(root: &Path, path: &str) -> Result<FileEntry> {
    read_regular_bounded(root, path, yoneda_agents_core::MAX_WORKSPACE_BYTES)
}
pub(crate) fn read_regular_bounded(root: &Path, path: &str, limit: usize) -> Result<FileEntry> {
    read_regular_detailed(root, path, limit).map_err(|failure| failure.error)
}
pub(crate) fn read_regular_detailed(
    root: &Path,
    path: &str,
    limit: usize,
) -> std::result::Result<FileEntry, ReadFailure> {
    let limit =
        u64::try_from(limit).map_err(|e| ReadFailure::bounded("limits", "FILE_LIMIT", e))?;
    yoneda_agents_core::validate_path(path)
        .map_err(|e| ReadFailure::bounded("path", "UNSAFE_PATH", e))?;
    let root_name = CString::new(root.as_os_str().as_bytes())
        .map_err(|e| ReadFailure::bounded("open_root", "UNSAFE_PATH", e))?;
    let mut directory = open_at(
        libc::AT_FDCWD,
        &root_name,
        libc::O_RDONLY | libc::O_DIRECTORY,
        "open_root",
    )?;
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        let name =
            CString::new(component).map_err(|e| ReadFailure::bounded("path", "UNSAFE_PATH", e))?;
        if components.peek().is_some() {
            directory = open_at(
                directory.as_raw_fd(),
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY,
                "open_parent",
            )?;
            continue;
        }
        let fd = open_at(
            directory.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_NONBLOCK,
            "open_file",
        )?;
        let file = File::from(fd);
        let metadata = file.metadata().map_err(|e| ReadFailure::io("stat", e))?;
        if !metadata.is_file() {
            return Err(ReadFailure::bounded(
                "stat",
                "UNSAFE_TYPE",
                "Capture requires a bounded regular file",
            ));
        }
        if metadata.len() > limit {
            return Err(ReadFailure::bounded(
                "limits",
                "FILE_LIMIT",
                "Capture requires a bounded regular file",
            ));
        }
        let mut content = Vec::new();
        file.take(limit + 1)
            .read_to_end(&mut content)
            .map_err(|e| ReadFailure::io("read", e))?;
        if u64::try_from(content.len())
            .map_err(|e| ReadFailure::bounded("limits", "FILE_LIMIT", e))?
            > limit
        {
            return Err(ReadFailure::bounded(
                "limits",
                "FILE_LIMIT",
                "File grew beyond capture limit",
            ));
        }
        return Ok(FileEntry::from_bytes(
            content,
            metadata.permissions().mode() & 0o111 != 0,
        ));
    }
    Err(ReadFailure::bounded(
        "path",
        "UNSAFE_PATH",
        "Empty capture path",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_parent_and_final_symlinks() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private"), "must not capture").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("parent")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("private"), root.path().join("final"))
            .unwrap();
        assert!(read_regular(root.path(), "parent/private").is_err());
        assert!(read_regular(root.path(), "final").is_err());
    }
}
