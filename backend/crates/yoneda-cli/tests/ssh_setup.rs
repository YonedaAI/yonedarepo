//! `yoneda ssh setup` against a stub platform, with a throwaway HOME and fake `ssh`, clipboard
//! and cloudflared programs first on PATH: nothing touches the real home, clipboard or network.
//! Every key here is a labelled fixture or generated for the test in its temporary directory.
#![cfg(unix)]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};

type TestResult<T = ()> = Result<T, String>;

const KEY: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPABZXfg3RaL8nBzQXBqjmhNRoourGMePyLCIP1iMDqH";
/// `ssh-keygen -lf` of `KEY`.
const FINGERPRINT: &str = "SHA256:8EqRGtHv7KPU4JP7ITUpjcB1ZW5aJP4ISN49NDYsKWo";
const HOST: &str = "ssh.example";

/// One `METHOD /path` answer: status line and JSON body.
type Answer = (&'static str, Value);
type Requests = Arc<Mutex<Vec<(String, Value)>>>;

fn tunnel() -> Value {
    json!({
        "front_door": "tunnel", "host": HOST,
        "clone_url": format!("ssh://git@{HOST}/<repository id>.git"),
        "ssh_config": format!("Host {HOST}\n  ProxyCommand cloudflared access ssh --hostname %h\n"),
    })
}

fn listed(keys: Value, ssh: Value) -> Answer {
    ("200 OK", json!({ "keys": keys, "ssh": ssh }))
}

fn added() -> Answer {
    (
        "200 OK",
        json!({ "id": "ssh_1", "fingerprint": FINGERPRINT, "title": "t", "ssh": tunnel() }),
    )
}

fn repos() -> Answer {
    (
        "200 OK",
        json!({ "repos": [{ "id": "r0123", "name": "demo", "visibility": "private" }] }),
    )
}

/// The platform for one scenario: `GET /ssh-keys`, `POST /ssh-keys`, `GET /repos`.
struct Platform {
    list: Answer,
    add: Answer,
}

impl Platform {
    fn open() -> Self {
        Self {
            list: listed(json!([]), tunnel()),
            add: added(),
        }
    }

    /// Serves the answers; returns the origin and the requests it has seen.
    fn start(self) -> TestResult<(String, Requests)> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let origin = format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let seen: Requests = Arc::default();
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = serve(stream, &self, &log);
            }
        });
        Ok((origin, seen))
    }
}

fn serve(
    mut stream: std::net::TcpStream,
    platform: &Platform,
    seen: &Requests,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut length = 0usize;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        if header.trim().is_empty() {
            break;
        }
        if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let path = path.strip_prefix("/api/v1").unwrap_or(path);
    if let Ok(mut log) = seen.lock() {
        log.push((
            format!("{method} {path}"),
            serde_json::from_slice(&body).unwrap_or(Value::Null),
        ));
    }
    let (status, reply) = match (method, path) {
        ("GET", "/ssh-keys") => platform.list.clone(),
        ("POST", "/ssh-keys") => platform.add.clone(),
        ("GET", "/repos") => repos(),
        _ => ("404 Not Found", json!({"error": {"code": "NOT_FOUND"}})),
    };
    let text = reply.to_string();
    write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    )
}

/// A throwaway home and a directory of fake programs.
struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

impl World {
    fn new() -> TestResult<Self> {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let root = std::fs::canonicalize(dir.path()).map_err(|e| e.to_string())?;
        for sub in ["home", "config", "bin", "work"] {
            std::fs::create_dir_all(root.join(sub)).map_err(|e| e.to_string())?;
        }
        let world = Self { _dir: dir, root };
        world.program("cloudflared", "exit 0")?;
        world.program(
            "ssh",
            "printf '%s\\n' \"$@\" >\"$0.args\"\n\
             echo \"Hi alice! You've successfully authenticated, but YonedaRepo does not provide shell access.\" >&2\n\
             exit 1",
        )?;
        world.program("pbcopy", "cat >\"$0.copied\"")?;
        Ok(world)
    }

    fn program(&self, name: &str, script: &str) -> TestResult {
        let path = self.root.join("bin").join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())
    }

    fn ssh_dir(&self) -> PathBuf {
        self.root.join("home/.ssh")
    }

    fn write_ssh(&self, name: &str, contents: &str) -> TestResult {
        std::fs::create_dir_all(self.ssh_dir()).map_err(|e| e.to_string())?;
        std::fs::write(self.ssh_dir().join(name), contents).map_err(|e| e.to_string())
    }

    fn with_key(self) -> TestResult<Self> {
        self.write_ssh("id_ed25519.pub", &format!("{KEY} alice@laptop\n"))?;
        Ok(self)
    }

    fn read(&self, path: &Path) -> String {
        std::fs::read_to_string(self.root.join(path)).unwrap_or_default()
    }

    /// `yoneda ssh setup` with PATH `path`.
    fn setup_on(&self, origin: &str, path: &str, flags: &[&str]) -> TestResult<Output> {
        Command::new(env!("CARGO_BIN_EXE_yoneda"))
            .args(["ssh", "setup", "--origin", origin])
            .args(flags)
            .current_dir(self.root.join("work"))
            .env("HOME", self.root.join("home"))
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("YONEDA_TOKEN", "ydt_fixture")
            .env("PATH", path)
            .env_remove("YONEDA_ORIGIN")
            .output()
            .map_err(|e| e.to_string())
    }

    /// With the fake programs ahead of the system's (`ssh-keygen` stays the real one).
    fn setup(&self, origin: &str) -> TestResult<Output> {
        let path = format!(
            "{}:{}",
            self.root.join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        self.setup_on(origin, &path, &[])
    }
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn stderr(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn success(out: &Output) -> TestResult {
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("failed: {}{}", stdout(out), stderr(out)))
    }
}

fn posts(seen: &Requests) -> Vec<Value> {
    seen.lock()
        .map(|log| {
            log.iter()
                .filter(|(what, _)| what == "POST /ssh-keys")
                .map(|(_, body)| body.clone())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn uses_the_existing_key_adds_it_and_writes_the_config_block() -> TestResult {
    let world = World::new()?.with_key()?;
    let (origin, seen) = Platform::open().start()?;
    let out = world.setup(&origin)?;
    success(&out)?;
    let text = stdout(&out);

    let sent = posts(&seen);
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["key"], KEY, "the comment is not sent");
    assert_eq!(sent[0]["title"], "alice@laptop");

    let config = world.read(Path::new("home/.ssh/config"));
    let cloudflared = world.root.join("bin/cloudflared");
    assert_eq!(
        config,
        format!(
            "# yoneda begin {HOST}\nHost {HOST}\n  ProxyCommand {} access ssh --hostname %h\n# yoneda end {HOST}\n",
            cloudflared.display()
        )
    );
    assert_eq!(
        world.read(Path::new("bin/pbcopy.copied")),
        format!("{KEY} alice@laptop\n")
    );
    assert!(text.contains(&format!("{KEY} alice@laptop")), "{text}");
    assert!(
        text.contains("copied to the clipboard with pbcopy"),
        "{text}"
    );
    assert!(text.contains("Hi alice!"), "{text}");
    assert!(
        text.contains(&format!("git clone ssh://git@{HOST}/r0123.git demo")),
        "{text}"
    );
    let args = world.read(Path::new("bin/ssh.args"));
    assert!(
        args.contains("-T\n") && args.contains(&format!("git@{HOST}\n")),
        "{args}"
    );
    Ok(())
}

#[test]
fn generates_a_key_only_when_there_is_none_and_never_prints_the_private_one() -> TestResult {
    let world = World::new()?;
    let (origin, seen) = Platform::open().start()?;
    let out = world.setup(&origin)?;
    success(&out)?;
    let text = format!("{}{}", stdout(&out), stderr(&out));
    assert!(text.contains("Generating"), "told first: {text}");
    assert!(!text.contains("PRIVATE KEY"), "{text}");

    let dir = world.ssh_dir();
    let mode = |p: &Path| std::fs::metadata(p).map(|m| m.permissions().mode() & 0o777);
    assert_eq!(mode(&dir).ok(), Some(0o700));
    assert_eq!(mode(&dir.join("id_ed25519")).ok(), Some(0o600));
    assert_eq!(mode(&dir.join("config")).ok(), Some(0o600));
    let public = std::fs::read_to_string(dir.join("id_ed25519.pub")).map_err(|e| e.to_string())?;
    assert!(public.starts_with("ssh-ed25519 "), "{public}");
    assert_eq!(posts(&seen).len(), 1);
    assert_eq!(
        posts(&seen)[0]["key"],
        public
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    );

    // The second run finds that key.
    let again = world.setup(&origin)?;
    success(&again)?;
    assert!(!stdout(&again).contains("Generating"));
    assert_eq!(
        std::fs::read_to_string(dir.join("id_ed25519.pub")).map_err(|e| e.to_string())?,
        public
    );
    Ok(())
}

#[test]
fn never_overwrites_a_private_key_that_has_no_public_file() -> TestResult {
    let world = World::new()?;
    world.write_ssh("id_ed25519", "fixture, not a real key\n")?;
    world.program("ssh-keygen", "touch \"$0.ran\"")?;
    let (origin, seen) = Platform::open().start()?;
    let out = world.setup(&origin)?;
    assert!(!out.status.success());
    let message = stderr(&out);
    assert!(
        message.contains("ssh-keygen -y"),
        "says what works: {message}"
    );
    assert_eq!(
        world.read(Path::new("home/.ssh/id_ed25519")),
        "fixture, not a real key\n"
    );
    assert!(!world.root.join("bin/ssh-keygen.ran").exists());
    assert!(posts(&seen).is_empty());
    assert!(!world.ssh_dir().join("config").exists());
    Ok(())
}

#[test]
fn a_key_already_on_the_account_counts_as_added() -> TestResult {
    let world = World::new()?.with_key()?;
    let (origin, seen) = Platform {
        list: listed(
            json!([{ "id": "ssh_1", "fingerprint": FINGERPRINT, "title": "laptop" }]),
            tunnel(),
        ),
        add: ("500 Internal Server Error", json!({})),
    }
    .start()?;
    let out = world.setup(&origin)?;
    success(&out)?;
    assert!(posts(&seen).is_empty());
    assert!(
        stdout(&out).contains("already on your account"),
        "{}",
        stdout(&out)
    );
    Ok(())
}

#[test]
fn a_key_held_by_another_account_stops_before_the_config() -> TestResult {
    let world = World::new()?.with_key()?;
    let (origin, _) = Platform {
        list: listed(json!([]), tunnel()),
        add: (
            "409 Conflict",
            json!({"error": {"code": "ALREADY_EXISTS", "message": "This key is already in use by an account"}}),
        ),
    }
    .start()?;
    let out = world.setup(&origin)?;
    assert!(!out.status.success());
    assert!(stderr(&out).contains("already in use"), "{}", stderr(&out));
    assert!(!world.ssh_dir().join("config").exists());
    Ok(())
}

#[test]
fn makes_no_key_while_ssh_is_off_or_the_token_cannot_manage_keys() -> TestResult {
    let off = json!({"front_door": null, "host": null, "clone_url": null, "ssh_config": null});
    let world = World::new()?;
    let (origin, _) = Platform {
        list: listed(json!([]), off),
        add: added(),
    }
    .start()?;
    let out = world.setup(&origin)?;
    assert!(!out.status.success());
    assert!(stderr(&out).contains("not open"), "{}", stderr(&out));
    assert!(!world.ssh_dir().exists());

    let (origin, _) = Platform {
        list: (
            "403 Forbidden",
            json!({"error": {"code": "FORBIDDEN", "message": "Token lacks the account:ssh-keys scope"}}),
        ),
        add: added(),
    }
    .start()?;
    let out = world.setup(&origin)?;
    assert!(!out.status.success());
    let message = stderr(&out);
    assert!(
        message.contains("yoneda login") && message.contains("SSH keys ticked"),
        "says what works: {message}"
    );
    assert!(!world.ssh_dir().exists());
    Ok(())
}

#[test]
fn refuses_a_host_that_could_inject_config_lines() -> TestResult {
    let world = World::new()?.with_key()?;
    let mut evil = tunnel();
    evil["host"] = json!("x\n  ProxyCommand touch /tmp/pwned");
    let (origin, _) = Platform {
        list: listed(json!([]), evil),
        add: added(),
    }
    .start()?;
    let out = world.setup(&origin)?;
    assert!(!out.status.success());
    assert!(!world.ssh_dir().join("config").exists());
    Ok(())
}

#[test]
fn a_second_run_leaves_the_config_as_it_was_and_keeps_other_entries() -> TestResult {
    let world = World::new()?.with_key()?;
    world.write_ssh("config", "Host work\n  User me")?;
    let (origin, _) = Platform::open().start()?;
    success(&world.setup(&origin)?)?;
    let first = world.read(Path::new("home/.ssh/config"));
    assert!(
        first.starts_with("Host work\n  User me\n\n# yoneda begin"),
        "{first}"
    );
    let again = world.setup(&origin)?;
    success(&again)?;
    assert_eq!(world.read(Path::new("home/.ssh/config")), first);
    assert!(
        stdout(&again).contains("Already routed"),
        "{}",
        stdout(&again)
    );
    Ok(())
}

#[test]
fn without_a_clipboard_or_cloudflared_it_still_prints_the_key_and_says_so() -> TestResult {
    let world = World::new()?.with_key()?;
    std::fs::remove_file(world.root.join("bin/pbcopy")).map_err(|e| e.to_string())?;
    std::fs::remove_file(world.root.join("bin/cloudflared")).map_err(|e| e.to_string())?;
    let (origin, _) = Platform::open().start()?;
    let path = world.root.join("bin").display().to_string();
    let out = world.setup_on(&origin, &path, &[])?;
    success(&out)?;
    let text = stdout(&out);
    assert!(text.contains(&format!("{KEY} alice@laptop")), "{text}");
    assert!(text.contains("no clipboard tool"), "{text}");
    assert!(text.contains("cloudflared was not found"), "{text}");
    assert!(
        world
            .read(Path::new("home/.ssh/config"))
            .contains("  ProxyCommand cloudflared access ssh --hostname %h\n")
    );
    assert!(
        !world.root.join("bin/ssh.args").exists(),
        "no check without cloudflared"
    );
    Ok(())
}

#[test]
fn a_direct_front_door_needs_no_config_and_json_reports_each_step() -> TestResult {
    let world = World::new()?.with_key()?;
    let mut direct = tunnel();
    direct["front_door"] = json!("connect");
    direct["ssh_config"] = Value::Null;
    let (origin, _) = Platform {
        list: listed(json!([]), direct),
        add: added(),
    }
    .start()?;
    let path = format!(
        "{}:{}",
        world.root.join("bin").display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let out = world.setup_on(&origin, &path, &["--json"])?;
    success(&out)?;
    assert!(!world.ssh_dir().join("config").exists());
    let document: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    assert_eq!(document["schema"], "yoneda.cli.ssh-setup.v1");
    let data = &document["data"];
    assert_eq!(data["generated"], false);
    assert_eq!(data["already_added"], false);
    assert_eq!(data["fingerprint"], FINGERPRINT);
    assert_eq!(data["config_path"], Value::Null);
    assert_eq!(data["clipboard"], "pbcopy");
    assert_eq!(data["check_passed"], true);
    assert_eq!(
        data["clone"],
        format!("git clone ssh://git@{HOST}/r0123.git demo")
    );
    Ok(())
}
