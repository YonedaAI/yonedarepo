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
use yoneda_core::{FileEntry, Result};

fn open_at(parent: i32, name: &std::ffi::CStr, flags: i32) -> Result<OwnedFd> {
    // SAFETY: name is NUL-terminated; successful openat gives this OwnedFd sole ownership.
    let fd = unsafe {
        libc::openat(
            parent,
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(err(std::io::Error::last_os_error()));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub(crate) fn read_regular(root: &Path, path: &str) -> Result<FileEntry> {
    yoneda_core::validate_path(path)?;
    let root_name = CString::new(root.as_os_str().as_bytes()).map_err(err)?;
    let mut directory = open_at(
        libc::AT_FDCWD,
        &root_name,
        libc::O_RDONLY | libc::O_DIRECTORY,
    )?;
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        let name = CString::new(component).map_err(err)?;
        if components.peek().is_some() {
            directory = open_at(
                directory.as_raw_fd(),
                &name,
                libc::O_RDONLY | libc::O_DIRECTORY,
            )?;
            continue;
        }
        let fd = open_at(
            directory.as_raw_fd(),
            &name,
            libc::O_RDONLY | libc::O_NONBLOCK,
        )?;
        let file = File::from(fd);
        let metadata = file.metadata().map_err(err)?;
        if !metadata.is_file() || metadata.len() > yoneda_core::MAX_WORKSPACE_BYTES as u64 {
            return Err(err("Capture requires a bounded regular file"));
        }
        let mut content = Vec::new();
        file.take(yoneda_core::MAX_WORKSPACE_BYTES as u64 + 1)
            .read_to_end(&mut content)
            .map_err(err)?;
        if content.len() > yoneda_core::MAX_WORKSPACE_BYTES {
            return Err(err("File grew beyond capture limit"));
        }
        return Ok(FileEntry::from_bytes(
            content,
            metadata.permissions().mode() & 0o111 != 0,
        ));
    }
    Err(err("Empty capture path"))
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
