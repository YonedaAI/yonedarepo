//! `yoneda local …`: runs the clone's local repository service, `yoneda-local`, installed
//! beside this CLI (or on PATH). The CLI stays an API client: the service hosts the
//! platform engine, which this crate does not depend on.
use crate::error::{Context, Error, Result};
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
