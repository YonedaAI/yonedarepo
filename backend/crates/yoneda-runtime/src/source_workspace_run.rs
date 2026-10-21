//! Root attempt lifetime: reap untrusted processes before unregistering, unmounting or sealing.
use crate::source_client::failure;
#[cfg(target_os = "linux")]
use crate::source_workspace_registry::SourceRegistration;
#[cfg(target_os = "linux")]
use crate::source_workspace_session::SourceSession;
use serde_json::Value;
use std::path::{Path, PathBuf};
use yoneda_agents_core::Result;
/// Runs blocking source work (FUSE mounts and syscalls, the source transport thread) on the
/// blocking pool. A standard-1 container has one async worker; blocking it there stops the
/// 20 s heartbeat and the supervisor server, so the attempt's lease expires mid-preparation.
pub(crate) async fn off_runtime<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| failure("SOURCE_IO", "Source preparation worker stopped"))?
}
pub(crate) struct SourceRun {
    #[cfg(target_os = "linux")]
    registration: Option<SourceRegistration>,
    #[cfg(target_os = "linux")]
    session: Option<SourceSession>,
    root: PathBuf,
}
impl SourceRun {
    pub(crate) fn prepare(job: &Value, root: &Path, evaluation: bool) -> Result<Self> {
        #[cfg(target_os = "linux")]
        {
            if crate::child_privileges::probe()["verified"] != true {
                return Err(failure(
                    "SOURCE_PRIVILEGES",
                    "Untrusted child privilege removal was not observed",
                ));
            }
            physical_directories()?;
            let session = if evaluation {
                SourceSession::prepare_evaluation(job, root)?
            } else {
                SourceSession::prepare(job, root)?
            };
            let working = session.working_directory();
            let registration = session.register(job)?;
            Ok(Self {
                registration: Some(registration),
                session: Some(session),
                root: working,
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (job, root, evaluation);
            Err(failure(
                "SOURCE_MOUNT_UNAVAILABLE",
                "API source execution requires Linux FUSE",
            ))
        }
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn finish(self, id: &str) -> Result<Value> {
        crate::process_guard::terminate_attempt()?;
        #[cfg(target_os = "linux")]
        {
            let mut this = self;
            this.registration.take();
            let session = this
                .session
                .take()
                .ok_or_else(|| failure("SOURCE_SCOPE", "Source session already closed"))?;
            let supervisor = std::env::var("SUPERVISOR_TOKEN")
                .map_err(|_| failure("FORBIDDEN", "Root source authorization missing"))?;
            session.finish(id, &supervisor)
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = id;
            Err(failure(
                "SOURCE_MOUNT_UNAVAILABLE",
                "API source execution requires Linux FUSE",
            ))
        }
    }
    pub(crate) fn close_evaluation(self) -> Result<()> {
        crate::process_guard::terminate_attempt()?;
        #[cfg(target_os = "linux")]
        {
            let mut this = self;
            this.registration.take();
            this.session
                .take()
                .ok_or_else(|| failure("SOURCE_SCOPE", "Evaluation session closed"))?
                .close_evaluation()
        }
        #[cfg(not(target_os = "linux"))]
        {
            Err(failure(
                "SOURCE_MOUNT_UNAVAILABLE",
                "API source execution requires Linux FUSE",
            ))
        }
    }
}
impl Drop for SourceRun {
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        if self.session.is_some() {
            let _ = crate::process_guard::terminate_attempt();
            self.registration.take();
            self.session.take();
        }
    }
}
#[cfg(target_os = "linux")]
fn physical_directories() -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    // Fixed physical directories only; never recurse through a mounted source tree.
    for path in [
        "/work/tmp",
        "/work/target",
        "/home/agent/.npm",
        "/home/agent/.cargo",
        "/home/agent/.codex",
    ] {
        let path = Path::new(path);
        std::fs::create_dir_all(path).map_err(|e| {
            crate::source_client::io_failure("Physical agent scratch unavailable", &e)
        })?;
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| failure("SOURCE_IO", "Invalid physical scratch path"))?;
        if unsafe { libc::chown(path.as_ptr(), 1000, 1000) } != 0 {
            return Err(failure(
                "SOURCE_IO",
                "Physical agent scratch ownership failed",
            ));
        }
    }
    Ok(())
}
#[cfg(test)]
#[path = "tests/source_workspace_run.rs"]
mod tests;
