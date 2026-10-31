//! The programs `ssh setup` looks for: cloudflared, the clipboard tools and `ssh` itself. Each
//! run is bounded, because a clipboard tool can sit on a missing display and `ssh` on a tunnel.
use crate::error::{Context, Result};
use std::ffi::OsStr;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const CLIPBOARD_TIMEOUT: Duration = Duration::from_secs(3);
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const CHECK_OUTPUT_CHARS: usize = 200;

/// Clipboard programs and their arguments; `clip.exe` is Windows' own, as WSL sees it.
const CLIPBOARDS: [(&str, &[&str]); 6] = [
    ("pbcopy", &[]),
    ("clip", &[]),
    ("clip.exe", &[]),
    ("wl-copy", &[]),
    ("xclip", &["-selection", "clipboard"]),
    ("xsel", &["--clipboard", "--input"]),
];

#[cfg(unix)]
fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn runnable(path: &Path) -> bool {
    path.is_file()
}

/// `program` in the directories of `path`, with `.exe` tried on Windows.
fn find_in(program: &str, path: &OsStr, windows: bool) -> Option<PathBuf> {
    let exe = format!("{program}.exe");
    let names: &[&str] = if windows {
        &[&exe, program]
    } else {
        &[program]
    };
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| runnable(candidate))
}

/// `program` on PATH, as an absolute path.
pub fn find(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let found = find_in(program, &path, cfg!(windows))?;
    std::path::absolute(&found).ok().or(Some(found))
}

/// cloudflared on PATH, else beside this program, where the installers put it. A symlink stays
/// as found: Homebrew's points through a versioned directory that the next upgrade removes.
pub fn cloudflared() -> Option<PathBuf> {
    let beside = || {
        let exe = std::env::current_exe().ok()?;
        find_in("cloudflared", exe.parent()?.as_os_str(), cfg!(windows))
    };
    find("cloudflared").or_else(beside)
}

/// Whether `child` ended well within `limit` (killed if it has not).
fn finished(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Feeds `text` to one clipboard program. Its output is discarded, not piped: `xclip` and
/// `wl-copy` leave a daemon holding the selection, and a pipe would stay open with it.
fn feed(program: &Path, args: &[&str], text: &str) -> Result<bool> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("starting a clipboard program")?;
    if let Some(mut input) = child.stdin.take() {
        input
            .write_all(text.as_bytes())
            .and_then(|()| input.write_all(b"\n"))
            .context("writing to a clipboard program")?;
    }
    Ok(finished(&mut child, CLIPBOARD_TIMEOUT))
}

/// Puts `text` on the clipboard with the first tool that takes it, found through `locate`.
fn copy_with(locate: impl Fn(&str) -> Option<PathBuf>, text: &str) -> Option<&'static str> {
    CLIPBOARDS.iter().find_map(|(name, args)| {
        let program = locate(name)?;
        feed(&program, args, text)
            .is_ok_and(|copied| copied)
            .then_some(*name)
    })
}

/// Puts `text` on the clipboard; the tool that took it, if any did.
pub fn copy(text: &str) -> Option<&'static str> {
    copy_with(find, text)
}

/// What `ssh -T` said.
#[derive(Debug, PartialEq, Eq)]
pub struct Check {
    pub passed: bool,
    pub output: String,
}

/// Passing is the platform's greeting (`ssh` itself exits 1 on it, with no shell to run).
fn judged(output: &str) -> Check {
    let output: String = output.trim().chars().take(CHECK_OUTPUT_CHARS).collect();
    Check {
        passed: output.contains("successfully authenticated"),
        output: if output.is_empty() {
            "no answer in time".to_owned()
        } else {
            output
        },
    }
}

fn collect(mut stream: impl Read + Send + 'static, into: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stream.read_to_string(&mut text);
        let _ = into.send(text);
    });
}

/// `ssh -T git@host`, as `git clone` will reach it; `None` without an `ssh` on PATH. A first
/// connection accepts the host key, which is what the person would answer at the prompt.
pub fn check(config: Option<&Path>, host: &str) -> Option<Check> {
    let ssh = find("ssh")?;
    let mut command = Command::new(ssh);
    if let Some(config) = config {
        command.arg("-F").arg(config);
    }
    let mut child = command
        .args(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"])
        .args(["-o", "StrictHostKeyChecking=accept-new"])
        .arg(format!("git@{host}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let (send, receive) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        collect(stdout, send.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        collect(stderr, send);
    }
    finished(&mut child, CHECK_TIMEOUT);
    // A surviving cloudflared can hold a pipe open: take what has arrived and move on.
    let mut output = String::new();
    while let Ok(text) = receive.recv_timeout(Duration::from_millis(300)) {
        output.push_str(&text);
    }
    Some(judged(&output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn looks_for_exe_on_windows_and_skips_what_cannot_run() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        std::fs::write(dir.path().join("tool.exe"), "").context("writing")?;
        std::fs::write(dir.path().join("plain"), "").context("writing")?;
        let path = dir.path().as_os_str();
        assert_eq!(
            find_in("tool", path, true),
            cfg!(not(unix)).then(|| dir.path().join("tool.exe"))
        );
        assert_eq!(find_in("tool", path, false), None);
        assert_eq!(find_in("missing", path, true), None);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_through_the_clipboard_tools() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().context("tempdir")?;
        let script = |name: &str, body: &str| -> Result<PathBuf> {
            let path = dir.path().join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).context("writing")?;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .context("chmod")?;
            Ok(path)
        };
        let none = |_: &str| None;
        assert_eq!(copy_with(none, "key"), None);

        // No display: the first tool fails, the next one takes it, arguments and all.
        let broken = script("wl-copy", "exit 1")?;
        let saved = dir.path().join("saved");
        let works = script(
            "xclip",
            &format!(
                "printf '%s' \"$*\" >'{0}.args'; cat >'{0}'",
                saved.display()
            ),
        )?;
        let locate = |name: &str| match name {
            "wl-copy" => Some(broken.clone()),
            "xclip" => Some(works.clone()),
            _ => None,
        };
        assert_eq!(copy_with(locate, "ssh-ed25519 AAAA"), Some("xclip"));
        assert_eq!(
            std::fs::read_to_string(&saved).context("reading")?,
            "ssh-ed25519 AAAA\n"
        );
        assert_eq!(
            std::fs::read_to_string(saved.with_extension("args")).context("reading")?,
            "-selection clipboard"
        );
        Ok(())
    }

    #[test]
    fn only_the_platform_greeting_passes() {
        assert!(judged("Hi alice! You've successfully authenticated, but …\n").passed);
        let denied = judged("git@ssh.example: Permission denied (publickey).\n");
        assert!(!denied.passed);
        assert_eq!(
            denied.output,
            "git@ssh.example: Permission denied (publickey)."
        );
        assert_eq!(judged(" \n").output, "no answer in time");
        assert_eq!(
            judged(&"x".repeat(500)).output.chars().count(),
            CHECK_OUTPUT_CHARS
        );
    }
}
