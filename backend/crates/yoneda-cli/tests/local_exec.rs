//! `yoneda local …` becomes `yoneda-local` (exec on Unix): the service runs under the PID
//! that was started, so stopping that PID stops the service, and no orphan is left behind.
#![cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

#[test]
fn yoneda_local_runs_the_service_in_its_own_process() {
    let dir = tempfile::tempdir().unwrap();
    // A copy of the CLI with no `yoneda-local` beside it, so PATH supplies a stand-in that
    // reports the PID it runs under.
    let cli = dir.path().join("yoneda");
    std::fs::copy(env!("CARGO_BIN_EXE_yoneda"), &cli).unwrap();
    let bin = dir.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let fake = bin.join("yoneda-local");
    std::fs::write(&fake, "#!/bin/sh\necho \"$$ $*\"\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = format!(
        "{}:{}",
        bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let child = Command::new(&cli)
        .args(["local", "status", "--json"])
        .env("PATH", path)
        .env("HOME", dir.path())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let started = child.id();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let said = String::from_utf8_lossy(&out.stdout);
    assert_eq!(said.trim(), format!("{started} status --json"));
}
