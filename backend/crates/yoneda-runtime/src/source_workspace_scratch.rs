//! Root-only bind mounts for frozen, untracked generated directories. Files never enter a changeset.
use crate::source_client::{failure, validate_path};
use std::{
    ffi::CString,
    fs,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::{Path, PathBuf},
};
use yoneda_agents_core::Result;
const GENERATED: &[&str] = &["node_modules", "target", ".venv", "__pycache__"];
/// Metadata must be the merged frozen view, including baseline overrides; no directory/content walk.
pub fn prefixes<'a>(tracked: impl Iterator<Item = &'a str>) -> Vec<String> {
    let tracked: Vec<_> = tracked.collect();
    GENERATED
        .iter()
        .filter(|prefix| {
            !tracked
                .iter()
                .any(|path| *path == **prefix || path.starts_with(&format!("{prefix}/")))
        })
        .map(|path| format!("{path}/"))
        .collect()
}
pub struct GeneratedScratch {
    root: tempfile::TempDir,
    mounts: Vec<PathBuf>,
}
impl GeneratedScratch {
    /// approved contains only server-derived prefixes absent from the frozen merged baseline.
    /// Caller must forbid model API writes in these generated prefixes and stop children before close.
    pub fn mount(project: &Path, approved: &[String]) -> Result<Self> {
        if approved.len() > GENERATED.len() {
            return Err(failure("SOURCE_SCOPE", "Invalid scratch prefix set"));
        }
        let root = tempfile::Builder::new()
            .prefix("yoneda-source-generated-")
            .tempdir()
            .map_err(|_| failure("SOURCE_IO", "Generated scratch unavailable"))?;
        let mut instance = Self {
            root,
            mounts: Vec::new(),
        };
        let mut seen = std::collections::BTreeSet::new();
        for approved_prefix in approved {
            let prefix = approved_prefix
                .strip_suffix('/')
                .ok_or_else(|| failure("SOURCE_SCOPE", "Scratch prefix must be a directory"))?;
            validate_path(prefix, false)?;
            if !GENERATED.contains(&prefix) || !seen.insert(prefix) {
                return Err(failure("SOURCE_SCOPE", "Invalid scratch prefix"));
            }
            let target = project.join(prefix);
            if fs::symlink_metadata(&target).is_ok() {
                return Err(failure(
                    "SOURCE_SCOPE",
                    "Generated prefix collides with source",
                ));
            }
            fs::create_dir(&target)
                .map_err(|_| failure("SOURCE_IO", "Generated directory metadata unavailable"))?;
            let physical = instance.root.path().join(prefix);
            fs::create_dir(&physical)
                .map_err(|_| failure("SOURCE_IO", "Generated scratch unavailable"))?;
            fs::set_permissions(&physical, fs::Permissions::from_mode(0o755))
                .map_err(|_| failure("SOURCE_IO", "Generated scratch mode unavailable"))?;
            let physical_c = cstring(&physical)?;
            let target_c = cstring(&target)?;
            // SAFETY: trusted, NUL-terminated paths; this is the root mount supervisor only.
            if unsafe { libc::chown(physical_c.as_ptr(), 1000, 1000) } != 0 {
                return Err(failure("SOURCE_MOUNT", "Scratch ownership failed"));
            }
            if unsafe {
                libc::mount(
                    physical_c.as_ptr(),
                    target_c.as_ptr(),
                    std::ptr::null(),
                    libc::MS_BIND,
                    std::ptr::null(),
                )
            } != 0
            {
                return Err(failure(
                    "SOURCE_MOUNT_UNAVAILABLE",
                    "Generated scratch bind unavailable",
                ));
            }
            instance.mounts.push(target.clone());
            if unsafe {
                libc::mount(
                    std::ptr::null(),
                    target_c.as_ptr(),
                    std::ptr::null(),
                    libc::MS_BIND | libc::MS_REMOUNT | libc::MS_NOSUID | libc::MS_NODEV,
                    std::ptr::null(),
                )
            } != 0
            {
                return Err(failure(
                    "SOURCE_MOUNT",
                    "Generated scratch security flags failed",
                ));
            }
        }
        Ok(instance)
    }
    pub fn close(mut self) -> Result<()> {
        self.unmount()
    }
    fn unmount(&mut self) -> Result<()> {
        while let Some(path) = self.mounts.last() {
            let path = cstring(path)?;
            // Children must be reaped, so ordinary unmount fails closed on a still-active FD.
            if unsafe { libc::umount2(path.as_ptr(), 0) } != 0 {
                return Err(failure(
                    "SOURCE_UNMOUNT",
                    "Generated scratch is still in use",
                ));
            }
            self.mounts.pop();
        }
        Ok(())
    }
}
impl Drop for GeneratedScratch {
    fn drop(&mut self) {
        let _ = self.unmount();
    }
}
fn cstring(path: &Path) -> Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| failure("INVALID_SOURCE", "Invalid scratch path"))
}
