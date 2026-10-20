//! Linux lazy source mount. File bytes are fetched only for actual file reads/writes.
#[path = "source_fs_controls.rs"]
mod controls;
#[path = "source_fs_mutations.rs"]
mod mutations;
#[path = "source_fs_reads.rs"]
mod reads;
#[path = "source_fs_state.rs"]
mod state;
#[path = "source_fs_writes.rs"]
mod writes;
use crate::{
    source_client::{SOURCE_READ_MAX, SourceChange, failure},
    source_workspace::SourceWorkspace,
};
use fuser::*;
use state::{FsState, errno};
use std::{ffi::OsStr, io, path::Path, sync::Arc, time::Duration};
use yoneda_agents_core::Result;

#[derive(Clone)]
pub struct SourceInvalidator {
    state: Arc<FsState>,
}
impl SourceInvalidator {
    pub fn invalidate(&self, paths: &[String]) -> Result<()> {
        self.state.invalidate(paths)
    }
}
pub struct SourceFs {
    state: Arc<FsState>,
}
pub struct SourceMount {
    state: Arc<FsState>,
    session: Option<BackgroundSession>,
}
impl SourceMount {
    pub fn mount(source: Arc<SourceWorkspace>, mountpoint: &Path) -> Result<Self> {
        if std::fs::read_dir(mountpoint)
            .map_err(|_| failure("SOURCE_MOUNT", "Source mount directory unavailable"))?
            .next()
            .is_some()
        {
            return Err(failure("SOURCE_MOUNT", "Source mountpoint must be empty"));
        }
        let state = Arc::new(FsState::new(source)?);
        let mut config = Config::default();
        config.acl = SessionACL::All;
        config.n_threads = Some(4);
        config.mount_options = vec![
            MountOption::FSName("yoneda-source-v1".into()),
            MountOption::DefaultPermissions,
            MountOption::NoDev,
            MountOption::NoSuid,
        ];
        if state.source.read_only() {
            config.mount_options.push(MountOption::RO);
        }
        let session = spawn_mount(
            SourceFs {
                state: state.clone(),
            },
            mountpoint,
            &config,
        )
        .map_err(|_| {
            failure(
                "SOURCE_MOUNT_UNAVAILABLE",
                "Linux FUSE mount is unavailable",
            )
        })?;
        *state
            .notifier
            .lock()
            .map_err(|_| failure("SOURCE_LOCK", "Source notifier lock failed"))? =
            Some(session.notifier());
        Ok(Self {
            state,
            session: Some(session),
        })
    }
    pub fn invalidator(&self) -> SourceInvalidator {
        SourceInvalidator {
            state: self.state.clone(),
        }
    }
    /// The platform calls this after source API mutations before exposing the new version.
    pub fn invalidate(&self, paths: &[String]) -> Result<()> {
        self.state.invalidate(paths)
    }
    pub fn close(mut self) -> Result<()> {
        self.state.source.cancel()?;
        if let Some(session) = self.session.take() {
            session
                .umount_and_join()
                .map_err(|_| failure("SOURCE_UNMOUNT", "Source mount shutdown failed"))?;
        }
        Ok(())
    }
}
impl Drop for SourceMount {
    fn drop(&mut self) {
        let _ = self.state.source.cancel();
        if let Some(session) = self.session.take() {
            let _ = session.umount_and_join();
        }
    }
}
impl Filesystem for SourceFs {
    reads::callbacks!();
    writes::callbacks!();
    controls::callbacks!();
}
