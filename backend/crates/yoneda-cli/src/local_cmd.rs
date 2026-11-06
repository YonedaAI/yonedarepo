//! `yoneda local …`: runs the clone's local repository service, `yoneda-local`, installed
//! beside this CLI (or on PATH). The CLI stays an API client: the service hosts the
//! platform engine, which this crate does not depend on.
#[cfg(not(unix))]
use crate::error::Error;
use crate::error::{Context, Result};
use std::path::PathBuf;

const BINARY: &str = if cfg!(windows) {
    "yoneda-local.exe"
} else {
    "yoneda-local"
};

/// `yoneda-local` next to this executable, else the name for PATH to resolve.
fn binary() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join(BINARY)))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(BINARY))
}

/// On Unix this process becomes `yoneda-local` (exec): the service keeps the PID that was
/// started, so stopping it (Ctrl-C, or a kill by that PID) stops the service rather than
/// leaving it running without its parent.
#[cfg(unix)]
pub fn run(args: &[String]) -> Result<()> {
    use std::os::unix::process::CommandExt;
    let failed = std::process::Command::new(binary()).args(args).exec();
    Err(failed).context("running yoneda-local (install it beside yoneda)")
}

#[cfg(not(unix))]
pub fn run(args: &[String]) -> Result<()> {
    let status = std::process::Command::new(binary())
        .args(args)
        .status()
        .context("running yoneda-local (install it beside yoneda)")?;
    if status.success() {
        return Ok(());
    }
    Err(Error {
        exit_code: status.code().unwrap_or(1),
        ..Error::new("yoneda local failed")
    })
}
