//! Fresh trusted Git object storage; never a clone or agent workspace.
use crate::source_git_tree::validate_oid;
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

const OBJECT_LIMIT: u64 = 32 * 1024 * 1024;
pub(crate) struct SourceGitObjects {
    root: PathBuf,
    objects: BTreeSet<String>,
}
impl SourceGitObjects {
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Root-only plumbing with bounded output; callers use fixed subcommands, never model arguments.
    pub fn execute(&self, args: &[&str], input: &[u8], max_output: usize) -> io::Result<Vec<u8>> {
        let mut child = self
            .command()
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Git plumbing input unavailable"))?;
        if stdin.write_all(input).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other("Git plumbing input failed"));
        }
        drop(stdin);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Git plumbing output unavailable"))?;
        let limit = u64::try_from(max_output)
            .ok()
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| io::Error::other("Git output limit overflow"))?;
        let mut output = Vec::new();
        stdout.take(limit).read_to_end(&mut output)?;
        if output.len() > max_output {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other(
                "Git output exceeds immutable review limit",
            ));
        }
        if !child.wait()?.success() {
            return Err(io::Error::other("Trusted Git plumbing failed"));
        }
        Ok(output)
    }
    pub fn create(root: &Path) -> io::Result<Self> {
        // create_dir fails for existing directories and symlinks: never inherit agent Git configuration.
        fs::create_dir(root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root, fs::Permissions::from_mode(0o700))?;
        }
        let store = Self {
            root: root.canonicalize()?,
            objects: BTreeSet::new(),
        };
        let output = store
            .command()
            .args(["init", "--bare", "--object-format=sha1", "--template="])
            .output()?;
        if !output.status.success() {
            return Err(io::Error::other("Trusted SHA-1 Git initialization failed"));
        }
        Ok(store)
    }

    fn command(&self) -> Command {
        let mut command = Command::new("/usr/bin/git");
        command
            .current_dir(&self.root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", "/nonexistent")
            .env("LANG", "C.UTF-8")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_ATTR_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.attributesFile=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "credential.helper=",
                "-c",
                "pack.threads=1",
            ]);
        command
    }

    pub fn write(&mut self, kind: &str, bytes: &[u8]) -> io::Result<String> {
        let size =
            u64::try_from(bytes.len()).map_err(|_| io::Error::other("Object size overflow"))?;
        self.write_reader(kind, size, bytes)
    }

    /// Verify metadata without putting unchanged base objects into the outgoing pack.
    pub fn hash(&self, kind: &str, bytes: &[u8]) -> io::Result<String> {
        self.hash_reader(kind, bytes.len() as u64, bytes)
    }
    pub fn hash_reader(&self, kind: &str, size: u64, reader: impl Read) -> io::Result<String> {
        self.object_reader(kind, size, reader, false)
    }
    /// Stream only verified changed bytes; no add, attributes or agent Git configuration.
    pub fn write_reader(&mut self, kind: &str, size: u64, reader: impl Read) -> io::Result<String> {
        let oid = self.object_reader(kind, size, reader, true)?;
        self.objects.insert(oid.clone());
        Ok(oid)
    }
    fn object_reader(
        &self,
        kind: &str,
        size: u64,
        reader: impl Read,
        persist: bool,
    ) -> io::Result<String> {
        if !["blob", "tree", "commit"].contains(&kind) || size > OBJECT_LIMIT {
            return Err(io::Error::other("Unsupported capture object kind or size"));
        }
        let mut command = self.command();
        command.arg("hash-object");
        if persist {
            command.arg("-w");
        }
        let mut child = command
            .args(["--stdin", "-t", kind])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Git object input unavailable"))?;
        let result = io::copy(&mut reader.take(size + 1), &mut { stdin });
        if !matches!(result, Ok(n) if n == size) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::other(
                "Changed object stream differs from sealed size",
            ));
        }
        let output = child.wait_with_output()?;
        if !output.status.success() {
            return Err(io::Error::other("Trusted object construction failed"));
        }
        let oid = std::str::from_utf8(&output.stdout)
            .map_err(|_| io::Error::other("Invalid Git object response"))?
            .trim()
            .to_owned();
        validate_oid(&oid)?;
        Ok(oid)
    }

    pub fn commit(&mut self, tree: &str, parents: &[String], message: &str) -> io::Result<String> {
        validate_oid(tree)?;
        if parents.is_empty()
            || parents.len() > 2
            || parents.iter().collect::<BTreeSet<_>>().len() != parents.len()
            || message.contains('\0')
            || message.len() > 4096
        {
            return Err(io::Error::other("Invalid frozen commit envelope"));
        }
        let mut raw = format!("tree {tree}\n");
        for parent in parents {
            validate_oid(parent)?;
            raw.push_str(&format!("parent {parent}\n"));
        }
        raw.push_str("author YonedaRepo capture <capture@yoneda.invalid> 1791331200 +0000\ncommitter YonedaRepo capture <capture@yoneda.invalid> 1791331200 +0000\n\n");
        raw.push_str(message);
        raw.push('\n');
        self.write("commit", raw.as_bytes())
    }

    /// No --revs, traversal, thin packs or delta reuse: stdin enumerates only constructed objects.
    pub fn pack(&self, max_bytes: u64) -> io::Result<PathBuf> {
        if max_bytes == 0 {
            return Err(io::Error::other("Empty Git pack capability"));
        }
        let path = self.root.join("incremental.pack");
        let mut output = fs::File::create(&path)?;
        let mut child = self
            .command()
            .args([
                "pack-objects",
                "--stdout",
                "--window=0",
                "--depth=0",
                "--no-reuse-delta",
                "--no-reuse-object",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("Git pack input unavailable"))?;
        for oid in &self.objects {
            writeln!(stdin, "{oid}")?;
        }
        drop(stdin);
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("Git pack output unavailable"))?;
        let limit = max_bytes
            .checked_add(1)
            .ok_or_else(|| io::Error::other("Git pack size overflow"))?;
        let copied = io::copy(&mut stdout.take(limit), &mut output)?;
        if copied > max_bytes {
            let _ = child.kill();
            let _ = child.wait();
            fs::remove_file(&path)?;
            return Err(io::Error::other(
                "Incremental pack exceeds source capability",
            ));
        }
        if !child.wait()?.success() {
            return Err(io::Error::other(
                "Explicit incremental pack construction failed",
            ));
        }
        Ok(path)
    }
}
