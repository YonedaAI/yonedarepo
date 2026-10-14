//! Atomic source mutation helpers; unsupported directory operations fail explicitly.
use super::state::FsState;
use crate::source_client::{SourceChange, SourceNode, failure};
use fuser::{FileHandle, INodeNo, RenameFlags};
use std::ffi::OsStr;
use yoneda_core::Result;

pub(super) fn rename(
    state: &FsState,
    parent: INodeNo,
    name: &OsStr,
    newparent: INodeNo,
    newname: &OsStr,
    flags: RenameFlags,
) -> Result<()> {
    if !flags.is_empty() {
        return Err(failure("INVALID_SOURCE", "Unsupported source rename flags"));
    }
    let from = state.child(parent, name)?;
    let to = state.child(newparent, newname)?;
    let node = state.directories.stat(&from)?;
    if node.directory() {
        return Err(failure(
            "SOURCE_UNSUPPORTED",
            "Directory rename is unsupported",
        ));
    }
    let target = match state.directories.stat(&to) {
        Ok(node) if node.directory() => {
            return Err(failure(
                "SOURCE_IS_DIRECTORY",
                "Cannot replace source directory",
            ));
        }
        Ok(node) => Some(node.version),
        Err(error) if error.code == "SOURCE_NOT_FOUND" => None,
        Err(error) => return Err(error),
    };
    state.apply(&SourceChange::Rename {
        path: from.clone(),
        expected: node.version,
        target: to.clone(),
        target_expected: target,
    })?;
    state.rename(&from, &to)
}
pub(super) fn setattr(
    state: &FsState,
    inode: INodeNo,
    mode: Option<u32>,
    size: Option<u64>,
    fh: Option<FileHandle>,
) -> Result<SourceNode> {
    let path = state.path(inode)?;
    let mut node = state.directories.stat(&path)?;
    if node.directory() && (size.is_some() || mode.is_some()) {
        return Err(failure(
            "SOURCE_UNSUPPORTED",
            "Directory changes are unsupported",
        ));
    }
    if let Some(size) = size {
        let expected = fh
            .map(|handle| state.handle(handle).map(|value| value.version))
            .transpose()?
            .unwrap_or(node.version);
        node = state
            .apply(&SourceChange::Truncate {
                path: path.clone(),
                expected,
                size,
            })?
            .ok_or_else(|| failure("SOURCE_FENCED", "Truncate returned no source file"))?;
    }
    if let Some(mode) = mode {
        node = state
            .apply(&SourceChange::Mode {
                path,
                expected: node.version,
                mode: if mode & 0o111 != 0 {
                    0o100755
                } else {
                    0o100644
                },
            })?
            .ok_or_else(|| failure("SOURCE_FENCED", "Mode change returned no source file"))?;
    }
    if let Some(handle) = fh {
        state.update_handle(handle, &node)?;
    }
    Ok(node)
}

pub(super) fn create(
    state: &FsState,
    parent: INodeNo,
    name: &OsStr,
    mode: u32,
    flags: fuser::OpenFlags,
) -> Result<SourceNode> {
    let path = state.child(parent, name)?;
    let change = match state.directories.stat(&path) {
        Ok(node) => {
            if node.directory() {
                return Err(failure(
                    "SOURCE_IS_DIRECTORY",
                    "Cannot replace source directory",
                ));
            }
            if flags.0 & libc::O_EXCL != 0 {
                return Err(failure("ALREADY_EXISTS", "Source file already exists"));
            }
            if flags.0 & libc::O_TRUNC == 0 {
                return Ok(node);
            }
            SourceChange::Truncate {
                path,
                expected: node.version,
                size: 0,
            }
        }
        Err(error) if error.code == "SOURCE_NOT_FOUND" => SourceChange::Create {
            path,
            mode: if mode & 0o111 != 0 {
                0o100755
            } else {
                0o100644
            },
        },
        Err(error) => return Err(error),
    };
    state
        .apply(&change)?
        .ok_or_else(|| failure("SOURCE_FENCED", "Create returned no source file"))
}
