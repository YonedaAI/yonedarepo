//! The builds, with stock Git in a bare repository the container throws away.
//!
//! `fetch` takes the repository's history from its mirror (the Artifacts remote, through the
//! Worker) and anything the mirror lacks of what is wanted from the platform's own smart
//! HTTP (through the Worker too; with the mirror's refs as haves, only the lag travels), then
//! counts the objects the wants reach. `pack` writes one clone's pack: `git rev-list
//! --objects` lists what a fetch with no haves gets (with `--filter=blob:none` for a partial
//! clone, `--no-walk` for depth 1: each wanted commit with its whole tree) and `git
//! pack-objects` writes it with real deltas (REF_DELTA, which every client takes).
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Instant;

pub type Result<T> = std::result::Result<T, String>;

/// A 40-hex object id, checked before it reaches a command line or stdin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Id(String);

impl Id {
    pub fn parse(text: &str) -> Result<Self> {
        let ok = text.len() == 40 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
        if ok {
            Ok(Self(text.to_owned()))
        } else {
            Err(format!("not an object id: {text:.60}"))
        }
    }
}

/// Ids, one per line (blank lines ignored); at least one.
pub fn ids(body: &[u8]) -> Result<Vec<Id>> {
    let text = std::str::from_utf8(body).map_err(|_| "ids are not text".to_owned())?;
    let ids = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| Id::parse(l.trim()));
    let ids = ids.collect::<Result<Vec<_>>>()?;
    if ids.is_empty() {
        Err("no object ids".into())
    } else {
        Ok(ids)
    }
}

fn lines(ids: &[Id]) -> Vec<u8> {
    ids.iter()
        .flat_map(|id| format!("{}\n", id.0).into_bytes())
        .collect()
}

/// Which pack of the wanted ids: a partial clone's (`blob:none`) and/or depth 1.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Shape {
    pub omit_blobs: bool,
    pub depth_one: bool,
}

impl Shape {
    /// From the query `filter=blob:none&depth=1` (either, both or neither).
    pub fn parse(query: &str) -> Result<Self> {
        let mut shape = Self::default();
        for pair in query.split('&').filter(|p| !p.is_empty()) {
            match pair {
                "filter=blob:none" => shape.omit_blobs = true,
                "depth=1" => shape.depth_one = true,
                other => return Err(format!("unknown pack option {other:.60}")),
            }
        }
        Ok(shape)
    }
}

/// What a step cost: wall ms, the Git processes' CPU ms, and the container's peak memory.
#[derive(Debug, Default, Clone)]
pub struct Cost {
    pub ms: u128,
    pub cpu_ms: u64,
    pub peak_mib: Option<u64>,
}

impl Cost {
    fn since(started: Instant, cpu_before: u64) -> Self {
        Self {
            ms: started.elapsed().as_millis(),
            cpu_ms: children_cpu_ms().saturating_sub(cpu_before),
            peak_mib: peak_mib(),
        }
    }
    pub fn json(&self) -> String {
        let peak = self.peak_mib.map_or("null".to_owned(), |m| m.to_string());
        format!(
            r#""ms":{},"cpu_ms":{},"peak_mib":{peak}"#,
            self.ms, self.cpu_ms
        )
    }
}

/// CPU of reaped child processes (utime + stime in /proc/self/stat, 100 ticks a second).
fn children_cpu_ms() -> u64 {
    let Ok(stat) = std::fs::read_to_string("/proc/self/stat") else {
        return 0;
    };
    // Fields after the parenthesised command: cutime and cstime are the 14th and 15th.
    let rest = stat.rsplit_once(')').map_or("", |(_, r)| r);
    let fields: Vec<u64> = rest
        .split_whitespace()
        .map(|f| f.parse().unwrap_or(0))
        .collect();
    (fields.get(13).copied().unwrap_or(0) + fields.get(14).copied().unwrap_or(0)) * 10
}

/// The container's peak memory (cgroup v2), when the kernel reports it.
fn peak_mib() -> Option<u64> {
    let text = std::fs::read_to_string("/sys/fs/cgroup/memory.peak").ok()?;
    text.trim().parse::<u64>().ok().map(|b| b / (1024 * 1024))
}

#[derive(Debug)]
pub struct Fetched {
    pub mirror: bool,
    pub from_platform: usize,
    pub objects: u64,
    pub cost: Cost,
}

#[derive(Debug, Clone)]
pub struct Packed {
    pub bytes: u64,
    pub cost: Cost,
}

pub struct Builder {
    repo: PathBuf,
    mirror: String,
    platform: String,
}

impl Builder {
    pub fn new(repo: &Path, mirror: &str, platform: &str) -> Self {
        Self {
            repo: repo.to_owned(),
            mirror: mirror.to_owned(),
            platform: platform.to_owned(),
        }
    }

    fn git(&self) -> Command {
        let mut command = Command::new("git");
        command
            .arg("--git-dir")
            .arg(&self.repo)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        command
    }

    /// Runs `args`, feeding `input`; its stdout, or its stderr's last line as the error.
    fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<Vec<u8>> {
        let mut command = self.git();
        command.args(args).stdout(Stdio::piped());
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("git did not start: {e}"))?;
        if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
            // A large input is written while Git reads it.
            let input = input.to_vec();
            std::thread::spawn(move || stdin.write_all(&input));
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("git failed: {e}"))?;
        if out.status.success() {
            return Ok(out.stdout);
        }
        Err(failure(args[0], &out.stderr))
    }

    fn init(&self) -> Result<()> {
        if self.repo.join("HEAD").exists() {
            return Ok(());
        }
        let repo = self.repo.to_str().ok_or("repository path is not text")?;
        let out = Command::new("git")
            .args(["init", "--bare", "-q", repo])
            .output();
        let out = out.map_err(|e| format!("git did not start: {e}"))?;
        if !out.status.success() {
            return Err(failure("init", &out.stderr));
        }
        for (key, value) in [
            ("protocol.version", "2"),
            ("gc.auto", "0"),
            ("pack.threads", "0"),
        ] {
            self.run(&["config", key, value], None)?;
        }
        Ok(())
    }

    /// Takes what `wants` reach: the mirror's history, then what it lacks from the platform.
    pub fn fetch(&self, wants: &[Id]) -> Result<Fetched> {
        let (started, cpu) = (Instant::now(), children_cpu_ms());
        self.init()?;
        let quiet = [
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-auto-gc",
        ];
        let refs = [
            "+refs/heads/*:refs/mirror/heads/*",
            "+refs/tags/*:refs/mirror/tags/*",
        ];
        let mirror = self.run(
            &[&quiet[..], &[self.mirror.as_str()], &refs[..]].concat(),
            None,
        );
        if let Err(e) = &mirror {
            log("pack.mirror_failed", &format!(r#""error":{}"#, quote(e)));
        }
        let missing = self.missing(wants)?;
        if !missing.is_empty() {
            let args = [&quiet[..], &["--stdin", self.platform.as_str()]].concat();
            self.run(&args, Some(&lines(&missing)))?;
            if let Some(id) = self.missing(&missing)?.first() {
                return Err(format!(
                    "{} is still missing after the platform fetch",
                    id.0
                ));
            }
        }
        let objects = self.count(wants)?;
        Ok(Fetched {
            mirror: mirror.is_ok(),
            from_platform: missing.len(),
            objects,
            cost: Cost::since(started, cpu),
        })
    }

    /// The wanted ids the repository does not hold.
    fn missing(&self, wants: &[Id]) -> Result<Vec<Id>> {
        let out = self.run(
            &["cat-file", "--batch-check=%(objectname)"],
            Some(&lines(wants)),
        )?;
        let out = String::from_utf8_lossy(&out);
        let gone: Vec<&str> = out
            .lines()
            .filter_map(|l| l.strip_suffix(" missing"))
            .collect();
        Ok(wants
            .iter()
            .filter(|id| gone.contains(&id.0.as_str()))
            .cloned()
            .collect())
    }

    /// Objects the wants reach (what a full clone of them carries).
    fn count(&self, wants: &[Id]) -> Result<u64> {
        let mut child = self.listing(wants, &Shape::default())?;
        let stdout = child.stdout.take().ok_or("rev-list has no output")?;
        let count = BufReader::new(stdout).split(b'\n').count() as u64;
        settle(child, "rev-list")?;
        Ok(count)
    }

    /// `git rev-list --objects` of `wants` as `shape` asks, reading them on stdin.
    fn listing(&self, wants: &[Id], shape: &Shape) -> Result<Child> {
        let mut command = self.git();
        command
            .args(["rev-list", "--objects", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if shape.omit_blobs {
            command.arg("--filter=blob:none");
        }
        if shape.depth_one {
            command.arg("--no-walk");
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("git did not start: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("rev-list has no input")?;
        let input = lines(wants);
        std::thread::spawn(move || stdin.write_all(&input));
        Ok(child)
    }

    /// Writes the pack of `wants` as `shape` asks to `out`, as Git writes it.
    pub fn pack(&self, wants: &[Id], shape: &Shape, out: &mut impl Write) -> Result<Packed> {
        let (started, cpu) = (Instant::now(), children_cpu_ms());
        let mut listing = self.listing(wants, shape)?;
        let names = listing.stdout.take().ok_or("rev-list has no output")?;
        let mut packer = self
            .git()
            .args(["pack-objects", "--stdout", "-q"])
            .stdin(Stdio::from(names))
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("git did not start: {e}"))?;
        let mut pack = packer.stdout.take().ok_or("pack-objects has no output")?;
        let bytes = copy(&mut pack, out);
        if bytes.is_err() {
            // The Worker went away: Git would block on a pipe nobody reads.
            let _ = packer.kill();
            let _ = listing.kill();
        }
        drop(pack);
        let listed = settle(listing, "rev-list");
        let packed = settle(packer, "pack-objects");
        let bytes = bytes.map_err(|e| format!("pack not sent: {e}"))?;
        listed?;
        packed?;
        Ok(Packed {
            bytes,
            cost: Cost::since(started, cpu),
        })
    }
}

fn copy(from: &mut impl Read, to: &mut impl Write) -> io::Result<u64> {
    let mut buffer = vec![0; 64 * 1024];
    let mut total = 0;
    loop {
        let read = from.read(&mut buffer)?;
        if read == 0 {
            return Ok(total);
        }
        to.write_all(&buffer[..read])?;
        total += read as u64;
    }
}

/// Waits for `child`; its stderr's last line when it failed.
fn settle(mut child: Child, what: &str) -> Result<()> {
    let mut stderr = Vec::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_end(&mut stderr);
    }
    let status = child.wait().map_err(|e| format!("{what} failed: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(failure(what, &stderr))
    }
}

fn failure(what: &str, stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let last = text
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("no message");
    format!("git {what}: {last:.300}")
}

/// A JSON string.
pub fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// One JSON log line (`fields`: the members after `event`).
pub fn log(event: &str, fields: &str) {
    let sep = if fields.is_empty() { "" } else { "," };
    println!(r#"{{"event":{}{sep}{fields}}}"#, quote(event));
}
