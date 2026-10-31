//! The key `ssh setup` uses: `~/.ssh/id_ed25519`, generated with `ssh-keygen` when there is
//! none. Only the public half is ever read; an existing key file is never written.
use super::tools;
use crate::error::{Context, Error, Result};
use crate::note;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The public key on disk.
#[derive(Debug)]
pub struct LocalKey {
    pub path: PathBuf,
    /// The `.pub` file's line, comment included.
    pub contents: String,
    pub generated: bool,
}

/// Whether anything is at `path`, a broken link included.
fn taken(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Creates `dir` private to its owner; an existing directory keeps its permissions.
pub fn private_dir(dir: &Path) -> Result<()> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .context(format!("creating {}", dir.display()))
}

fn generate(private: &Path) -> Result<()> {
    let keygen = tools::find("ssh-keygen").ok_or_else(|| {
        Error::new(
            "Install the OpenSSH client (it provides ssh-keygen), then run `yoneda ssh setup` again",
        )
    })?;
    if let Some(dir) = private.parent() {
        private_dir(dir)?;
    }
    let out = Command::new(keygen)
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(private)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .context("running ssh-keygen")?;
    if out.status.success() {
        return Ok(());
    }
    Err(Error::new(format!(
        "ssh-keygen failed: {}",
        String::from_utf8_lossy(&out.stderr).trim()
    )))
}

/// The default key in `ssh_dir`: its `.pub` if there is one, else a new key. A private key
/// without its `.pub` stops here, since generating would have to overwrite it.
pub fn ensure(ssh_dir: &Path) -> Result<LocalKey> {
    let private = ssh_dir.join("id_ed25519");
    let path = ssh_dir.join("id_ed25519.pub");
    let generated = !taken(&path);
    if generated {
        if taken(&private) {
            return Err(Error::new(format!(
                "Run `ssh-keygen -y -f {} > {}`, then `yoneda ssh setup` again: that private key has no .pub file, and it is never overwritten",
                private.display(),
                path.display()
            )));
        }
        note!(
            "Generating {} with ssh-keygen (ed25519, no passphrase)",
            private.display()
        );
        generate(&private)?;
    }
    let contents = std::fs::read_to_string(&path).context(format!("reading {}", path.display()))?;
    Ok(LocalKey {
        contents: contents.trim().to_owned(),
        path,
        generated,
    })
}

/// A public key line's `SHA256:` fingerprint, as `ssh-keygen -lf` prints it.
pub fn fingerprint(line: &str) -> Result<String> {
    let body = line.split_whitespace().nth(1).unwrap_or_default();
    let blob = STANDARD
        .decode(body)
        .context("the public key is not valid base64")?;
    Ok(format!(
        "SHA256:{}",
        STANDARD_NO_PAD.encode(Sha256::digest(&blob))
    ))
}

#[cfg(test)]
mod tests {
    use super::fingerprint;

    #[test]
    fn fingerprints_match_ssh_keygen() {
        // `ssh-keygen -lf` of the platform's test key (accounts/ssh_keys_tests.rs).
        let line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH test@ed25519";
        assert_eq!(
            fingerprint(line).ok().as_deref(),
            Some("SHA256:8EqRGtHv7KPU4JP7ITUpjcB1ZW5aJP4ISN49NDYsKWo")
        );
        assert!(fingerprint("ssh-ed25519 %%%").is_err());
    }
}
