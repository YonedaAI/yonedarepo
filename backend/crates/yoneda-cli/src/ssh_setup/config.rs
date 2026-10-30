//! The `~/.ssh/config` block: `# yoneda begin <host>` … `# yoneda end <host>`, one per host so
//! dev and prod can sit side by side. Everything outside a block is kept byte for byte, and
//! the file is replaced atomically, through any symlink a dotfile manager put there.
use super::key::private_dir;
use crate::error::{Context, Error, Result};
use std::io::Write;
use std::path::Path;

/// `path` as the program of a `ProxyCommand`. `%` is OpenSSH's token character everywhere.
/// POSIX ssh hands the line to a shell; Win32-OpenSSH hands it to CreateProcess, which takes
/// double quotes only (Git for Windows' `sh` reads the same form), and Windows paths hold no `"`.
pub fn proxy_program(path: &str, windows: bool) -> String {
    let path = path.replace('%', "%%");
    if windows {
        return format!("\"{path}\"");
    }
    let plain = path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"/._-+%=:@,".contains(&b));
    if plain {
        path
    } else {
        format!("'{}'", path.replace('\'', r"'\''"))
    }
}

fn begin(host: &str) -> String {
    format!("# yoneda begin {host}")
}

fn end(host: &str) -> String {
    format!("# yoneda end {host}")
}

/// The block for `host`, with its `ProxyCommand` program already quoted.
pub fn block(host: &str, program: &str) -> String {
    format!(
        "{}\nHost {host}\n  ProxyCommand {program} access ssh --hostname %h\n{}\n",
        begin(host),
        end(host)
    )
}

/// `existing` with `host`'s block in place: replaced where it stands, else appended. Bytes,
/// because a config file need not be UTF-8. A block with one marker missing is refused, since
/// where it ends would be a guess about somebody else's lines.
pub fn merged(existing: &[u8], host: &str, block: &str) -> Result<Vec<u8>> {
    let lines: Vec<&[u8]> = existing.split_inclusive(|b| *b == b'\n').collect();
    let at = |marker: String| {
        lines
            .iter()
            .position(|line| line.trim_ascii() == marker.as_bytes())
    };
    match (at(begin(host)), at(end(host))) {
        (Some(from), Some(to)) if from < to => {
            let mut out = lines[..from].concat();
            out.extend_from_slice(block.as_bytes());
            out.extend_from_slice(&lines[to + 1..].concat());
            Ok(out)
        }
        (None, None) => {
            let mut out = existing.to_vec();
            if !out.is_empty() {
                if out.last() != Some(&b'\n') {
                    out.push(b'\n');
                }
                out.push(b'\n');
            }
            out.extend_from_slice(block.as_bytes());
            Ok(out)
        }
        _ => Err(Error::new(format!(
            "Delete the `{}` and `{}` lines from your SSH config, then run `yoneda ssh setup` again: only one of the two was found",
            begin(host),
            end(host)
        ))),
    }
}

/// Replaces `path` with `bytes` in one step, with the old file's permissions (0600 when new).
fn replace(path: &Path, bytes: &[u8]) -> Result<()> {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let previous = std::fs::metadata(&target).ok();
    let staging = target.with_file_name(format!(".config.yoneda-{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&staging).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Some(meta) = &previous {
            std::fs::set_permissions(&staging, meta.permissions())?;
        }
        std::fs::rename(&staging, &target)
    });
    if written.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    written.context(format!("writing {}", target.display()))
}

/// Puts `host`'s block in the config at `path`; whether the file changed.
pub fn install(path: &Path, host: &str, program: &str) -> Result<bool> {
    if let Some(dir) = path.parent() {
        private_dir(dir)?;
    }
    let existing = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e).context(format!("reading {}", path.display())),
    };
    let updated = merged(&existing, host, &block(host, program))?;
    if updated == existing {
        return Ok(false);
    }
    replace(path, &updated)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST: &str = "ssh.yonedarepo.com";

    fn text(bytes: Vec<u8>) -> String {
        String::from_utf8_lossy(&bytes).into_owned()
    }

    #[test]
    fn quotes_the_program_for_each_platform() {
        for (path, quoted) in [
            (
                "/opt/homebrew/bin/cloudflared",
                "/opt/homebrew/bin/cloudflared",
            ),
            (
                "/home/a b/.local/bin/cloudflared",
                "'/home/a b/.local/bin/cloudflared'",
            ),
            (
                "/home/o'neil/bin/cloudflared",
                r"'/home/o'\''neil/bin/cloudflared'",
            ),
            ("/home/a$b/cloudflared", "'/home/a$b/cloudflared'"),
            ("/home/100%/cloudflared", "/home/100%%/cloudflared"),
        ] {
            assert_eq!(proxy_program(path, false), quoted, "{path}");
        }
        assert_eq!(
            proxy_program(
                r"C:\Users\Ada Lovelace\AppData\Local\Programs\yoneda\cloudflared.exe",
                true
            ),
            r#""C:\Users\Ada Lovelace\AppData\Local\Programs\yoneda\cloudflared.exe""#
        );
        assert_eq!(
            proxy_program(r"C:\Program Files (x86)\100%\cloudflared.exe", true),
            r#""C:\Program Files (x86)\100%%\cloudflared.exe""#
        );
    }

    /// Stock OpenSSH reads each quoted form back as written (`ssh -G` connects to nothing).
    #[test]
    fn stock_ssh_parses_the_block_with_each_quoting() -> Result<()> {
        if std::process::Command::new("ssh")
            .arg("-V")
            .output()
            .is_err()
        {
            return Ok(());
        }
        let dir = tempfile::tempdir().context("tempdir")?;
        for program in [
            proxy_program("/home/a b/cloudflared", false),
            proxy_program("/home/o'neil/cloudflared", false),
            proxy_program("/home/100%/cloudflared", false),
            proxy_program(r"C:\Users\Ada Lovelace\cloudflared.exe", true),
        ] {
            let config = dir.path().join("config");
            std::fs::write(&config, block(HOST, &program)).context("writing")?;
            let out = std::process::Command::new("ssh")
                .arg("-G")
                .arg("-F")
                .arg(&config)
                .arg(HOST)
                .output()
                .context("ssh -G")?;
            let printed = String::from_utf8_lossy(&out.stdout).into_owned();
            let expected = format!("proxycommand {program} access ssh --hostname %h\n");
            assert!(
                out.status.success() && printed.contains(&expected),
                "{program}: {printed} {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        Ok(())
    }

    #[test]
    fn appends_to_a_file_and_replaces_in_place_afterwards() -> Result<()> {
        let first = block(HOST, "/a/cloudflared");
        assert_eq!(text(merged(b"", HOST, &first)?), first);
        let other = "Host work\n  User me\n";
        let added = merged(other.as_bytes(), HOST, &first)?;
        assert_eq!(text(added.clone()), format!("{other}\n{first}"));
        assert_eq!(merged(&added, HOST, &first)?, added, "idempotent");

        // A new cloudflared path moves nothing around it.
        let around = format!("Host a\n  User a\n{first}Host b\n  User b");
        let second = block(HOST, "/b/cloudflared");
        assert_eq!(
            text(merged(around.as_bytes(), HOST, &second)?),
            format!("Host a\n  User a\n{second}Host b\n  User b")
        );
        Ok(())
    }

    #[test]
    fn keeps_other_hosts_blocks_crlf_and_bytes_that_are_not_utf8() -> Result<()> {
        let dev = block("ssh.dev.yonedarepo.com", "/a/cloudflared");
        let both = merged(dev.as_bytes(), HOST, &block(HOST, "/a/cloudflared"))?;
        assert!(text(both.clone()).contains(&dev));
        assert_eq!(merged(&both, "ssh.dev.yonedarepo.com", &dev)?, both);

        let crlf = block(HOST, "/a/cloudflared").replace('\n', "\r\n");
        let windows = format!("Host a\r\n{crlf}Host b\r\n");
        assert_eq!(
            text(merged(
                windows.as_bytes(),
                HOST,
                &block(HOST, "/b/cloudflared")
            )?),
            format!("Host a\r\n{}Host b\r\n", block(HOST, "/b/cloudflared"))
        );

        let latin1 = b"# caf\xe9\nHost a\n";
        let out = merged(latin1, HOST, &block(HOST, "/a/cloudflared"))?;
        assert!(out.starts_with(latin1));
        Ok(())
    }

    #[test]
    fn refuses_a_block_with_a_marker_missing_and_changes_nothing() {
        for broken in [
            format!("{}\nHost {HOST}\nHost mine\n", begin(HOST)),
            format!("Host mine\n{}\n", end(HOST)),
            format!("{}\n{}\n", end(HOST), begin(HOST)),
        ] {
            let refused = merged(broken.as_bytes(), HOST, &block(HOST, "/a/cloudflared"));
            assert!(
                refused.is_err_and(|e| e.message.contains("Delete the")),
                "{broken}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn creates_private_files_keeps_modes_and_follows_links() -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().context("tempdir")?;
        let mode = |p: &Path| {
            std::fs::metadata(p)
                .map(|m| m.permissions().mode() & 0o777)
                .unwrap_or(0)
        };
        let config = dir.path().join("new/.ssh/config");
        assert!(install(&config, HOST, "/a/cloudflared")?);
        assert_eq!(mode(&config), 0o600);
        assert_eq!(
            mode(config.parent().ok_or_else(|| Error::new("parent"))?),
            0o700
        );
        assert!(
            !install(&config, HOST, "/a/cloudflared")?,
            "no second write"
        );

        let dotfiles = dir.path().join("dotfiles-config");
        std::fs::write(&dotfiles, "Host a\n").context("writing")?;
        std::fs::set_permissions(&dotfiles, std::fs::Permissions::from_mode(0o640))
            .context("chmod")?;
        let link = dir.path().join("linked");
        std::os::unix::fs::symlink(&dotfiles, &link).context("symlink")?;
        assert!(install(&link, HOST, "/a/cloudflared")?);
        assert!(std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink()));
        assert_eq!(mode(&dotfiles), 0o640);
        let written = std::fs::read_to_string(&dotfiles).context("reading")?;
        assert!(written.starts_with("Host a\n") && written.contains("ProxyCommand"));
        let left: Vec<_> = std::fs::read_dir(dir.path())
            .context("listing")?
            .flatten()
            .map(|e| e.file_name())
            .filter(|n| n.to_string_lossy().contains("yoneda"))
            .collect();
        assert!(left.is_empty(), "staging file left: {left:?}");
        Ok(())
    }
}
