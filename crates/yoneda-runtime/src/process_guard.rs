//! Each container reserves UID 1000 exclusively for its one untrusted attempt.
//! A Linux subreaper and kernel UID signal barrier contain children even after setsid().
use yoneda_core::Result;
pub(crate) struct AgentProcesses(bool);
impl AgentProcesses {
    pub(crate) fn prepare() -> Result<Self> {
        #[cfg(target_os = "linux")]
        if unsafe { libc::geteuid() } == 0 {
            // SAFETY: this process becomes the parent of orphaned descendants; no pointers.
            if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
                return Err(crate::err(std::io::Error::last_os_error()));
            }
            return Ok(Self(true));
        }
        Ok(Self(false))
    }
    pub(crate) fn finish(&mut self) -> Result<()> {
        #[cfg(target_os = "linux")]
        if self.0 {
            terminate_uid()?;
        }
        self.0 = false;
        Ok(())
    }
}
impl Drop for AgentProcesses {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}
#[cfg(target_os = "linux")]
fn terminate_uid() -> Result<()> {
    use crate::err;
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        // The helper drops to the reserved UID. Kernel permission checks ensure this
        // broadcast cannot signal the root supervisor, even if process IDs are reused.
        // SAFETY: the forked branch uses only async-signal-safe calls and exits directly.
        let killer = unsafe { libc::fork() };
        if killer < 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        if killer == 0 {
            unsafe {
                if libc::setresgid(1000, 1000, 1000) != 0 || libc::setresuid(1000, 1000, 1000) != 0
                {
                    libc::_exit(1);
                }
                libc::kill(-1, libc::SIGSTOP);
                libc::kill(-1, libc::SIGKILL);
                libc::_exit(0);
            }
        }
        let mut status = 0;
        if unsafe { libc::waitpid(killer, &mut status, 0) } != killer || status != 0 {
            return Err(err("UID termination helper failed"));
        }
        while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {}
        let mut found = false;
        for entry in std::fs::read_dir("/proc").map_err(err)? {
            let entry = entry.map_err(err)?;
            if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
                continue;
            }
            let status = match std::fs::read_to_string(entry.path().join("status")) {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(err(error)),
            };
            if status
                .lines()
                .find(|l| l.starts_with("Uid:"))
                .is_some_and(|l| l.split_whitespace().skip(1).any(|uid| uid == "1000"))
            {
                found = true;
                break;
            }
        }
        if !found {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(err(
                "Untrusted processes did not quiesce; refusing source capture",
            ));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
