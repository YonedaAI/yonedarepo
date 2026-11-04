//! One service per clone: `serve` holds an exclusive lock on `serve.lock` for as long as it
//! runs (the OS drops it when the process ends, however it ends) and records its PID.
use crate::layout::{Layout, local_error};
use std::fs::{File, OpenOptions, TryLockError};
use yoneda_core::Result;

pub struct Held(#[allow(dead_code)] File);

pub fn take(layout: &Layout) -> Result<Held> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(layout.lock())
        .map_err(|e| local_error(format!("Cannot open the lock: {e}")))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            let pid = std::fs::read_to_string(layout.pid()).unwrap_or_default();
            return Err(local_error(format!(
                "The local service is already running (pid {})",
                pid.trim()
            )));
        }
        Err(TryLockError::Error(e)) => return Err(local_error(format!("Cannot lock: {e}"))),
    }
    std::fs::write(layout.pid(), std::process::id().to_string())
        .map_err(|e| local_error(format!("Cannot record the pid: {e}")))?;
    Ok(Held(file))
}
