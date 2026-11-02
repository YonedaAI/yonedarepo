//! Repositories by `<owner>/<name>` on a person's machine, against a small canned platform:
//! `yoneda clone` prints what Git prints and lands in `./<name>`, also for an empty repository;
//! `yoneda` works inside any clone by name; `yoneda repo remote add` points a project at one.
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

const EMPTY: &str = "r0123456789abcdef0123";
const OTHER: &str = "rfedcba9876543210fedc";

type TestResult<T = ()> = Result<T, String>;

/// A commit on a branch of `OTHER`, for a push that deletes it.
const DOOMED: &str = "cccccccccccccccccccccccccccccccccccccccc";

fn answer(path: &str, body: &str) -> (&'static str, Value) {
    if path.ends_with("/refs/batch") {
        // What a delete must send: the branch, no new commit, and what it expects to find.
        let updates = serde_json::from_str::<Value>(body).unwrap_or_default();
        let wanted = json!([{ "ref": "refs/heads/doomed", "commit": null, "expected": DOOMED }]);
        return if updates["updates"] == wanted {
            ("200 OK", json!({ "version": 2, "refs": {} }))
        } else {
            let error = json!({ "code": "INVALID_INPUT", "message": updates.to_string() });
            ("400 Bad Request", json!({ "error": error }))
        };
    }
    let refs = if path.contains(OTHER) {
        json!({ "version": 1, "refs": { "refs/heads/doomed": DOOMED } })
    } else {
        json!({ "version": 0, "refs": {} })
    };
    let status = json!({ "name": "empty", "visibility": "private", "version": 0, "refs": [] });
    match path {
        "/api/v1/resolve/ada/empty" => ("200 OK", json!({ "id": EMPTY })),
        "/api/v1/resolve/ada/other" => ("200 OK", json!({ "id": OTHER })),
        p if p.ends_with("/refs") => ("200 OK", refs),
        p if p == format!("/api/v1/repos/{EMPTY}") => ("200 OK", status),
        _ => (
            "404 Not Found",
            json!({ "error": { "code": "NOT_FOUND", "message": "No such repository" } }),
        ),
    }
}

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
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
    let mut sent = vec![0u8; length];
    reader.read_exact(&mut sent)?;
    let target = first.split_whitespace().nth(1).unwrap_or_default();
    let path = target.split('?').next().unwrap_or_default();
    let (status, body) = answer(path, &String::from_utf8_lossy(&sent));
    let text = body.to_string();
    write!(
        stream,
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    )
}

/// A throwaway home signed in to the canned platform, with the built CLI on PATH.
struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    origin: String,
}

impl World {
    fn new() -> TestResult<Self> {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let root = std::fs::canonicalize(dir.path()).map_err(|e| e.to_string())?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let origin = format!(
            "http://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let _ = serve(stream);
            }
        });
        let config = root.join("config/yoneda");
        std::fs::create_dir_all(&config).map_err(|e| e.to_string())?;
        let stored = json!({ "origin": origin, "token": "ypat_fixture" }).to_string();
        std::fs::write(config.join("credentials"), stored).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(root.join("work")).map_err(|e| e.to_string())?;
        Ok(Self {
            _dir: dir,
            root,
            origin,
        })
    }

    fn command(&self, program: &str, dir: &Path, args: &[&str]) -> TestResult<Output> {
        let bin = Path::new(env!("CARGO_BIN_EXE_yoneda"))
            .parent()
            .ok_or("no bin dir")?;
        let path = format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        Command::new(program)
            .args(args)
            .current_dir(dir)
            .env("HOME", self.root.join("work"))
            .env("PATH", path)
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env_remove("YONEDA_TOKEN")
            .env_remove("YONEDA_ORIGIN")
            .stdin(Stdio::null())
            .output()
            .map_err(|e| e.to_string())
    }

    fn yoneda(&self, dir: &Path, args: &[&str]) -> TestResult<Output> {
        self.command(env!("CARGO_BIN_EXE_yoneda"), dir, args)
    }

    fn git(&self, dir: &Path, args: &[&str]) -> TestResult<String> {
        let out = self.command("git", dir, args)?;
        if !out.status.success() {
            return Err(said(&out));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    fn work(&self) -> PathBuf {
        self.root.join("work")
    }

    /// A Git repository with no remote.
    fn project(&self) -> TestResult<PathBuf> {
        let dir = self.work().join("project");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        self.git(&dir, &["init", "-q", "-b", "main"])?;
        Ok(dir)
    }
}

fn said(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn ensure(condition: bool, what: impl Into<String>) -> TestResult {
    if condition { Ok(()) } else { Err(what.into()) }
}

#[test]
fn clone_by_name_prints_like_git_and_lands_in_the_name_even_when_empty() -> TestResult {
    let w = World::new()?;
    let out = w.yoneda(&w.work(), &["clone", "ada/empty"])?;
    let text = said(&out);
    ensure(out.status.success(), &text)?;
    let from = format!("Cloning yoneda::{}/ada/empty\n", w.origin);
    ensure(text.contains(&from), format!("no source line: {text}"))?;
    ensure(text.contains("Cloning into 'empty'..."), text.clone())?;
    ensure(text.contains("cloned an empty repository"), text.clone())?;
    ensure(w.work().join("empty/.git").exists(), "not in ./empty")?;
    ensure(!w.work().join("ada").exists(), "a folder for the owner")?;
    let url = w.git(&w.work().join("empty"), &["remote", "get-url", "origin"])?;
    ensure(url == format!("yoneda::{}/ada/empty", w.origin), url)
}

#[test]
fn clone_by_name_into_a_named_folder() -> TestResult {
    let w = World::new()?;
    let out = w.yoneda(&w.work(), &["clone", "ada/empty", "here"])?;
    ensure(out.status.success(), said(&out))?;
    ensure(said(&out).contains("Cloning into 'here'..."), said(&out))?;
    ensure(w.work().join("here/.git").exists(), "not in ./here")
}

#[test]
fn yoneda_works_inside_a_clone_by_name() -> TestResult {
    let w = World::new()?;
    let by_cli = w.yoneda(&w.work(), &["clone", "ada/empty"])?;
    ensure(by_cli.status.success(), said(&by_cli))?;
    let url = format!("yoneda::{}/ada/empty", w.origin);
    w.git(&w.work(), &["clone", "-q", &url, "by-git"])?;
    for folder in ["empty", "by-git"] {
        let out = w.yoneda(&w.work().join(folder), &["status"])?;
        ensure(out.status.success(), format!("{folder}: {}", said(&out)))?;
        ensure(said(&out).contains(EMPTY), said(&out))?;
    }
    Ok(())
}

#[test]
fn clone_by_id_lands_in_the_repository_name_too() -> TestResult {
    let w = World::new()?;
    let out = w.yoneda(&w.work(), &["clone", EMPTY])?;
    ensure(out.status.success(), said(&out))?;
    ensure(said(&out).contains("Cloning into 'empty'..."), said(&out))?;
    ensure(w.work().join("empty/.git").exists(), "not in ./empty")?;
    ensure(!w.work().join(EMPTY).exists(), "a folder named by the id")
}

#[test]
fn clone_refuses_what_is_neither_a_name_nor_an_id() -> TestResult {
    let w = World::new()?;
    let bare = w.yoneda(&w.work(), &["clone", "empty"])?;
    ensure(bare.status.code() == Some(64), said(&bare))?;
    let text = said(&bare);
    ensure(text.contains("<owner>/<name>"), text.clone())?;
    ensure(!text.contains("git clone"), text)?;
    let unknown = w.yoneda(&w.work(), &["clone", "ada/nobody"])?;
    ensure(!unknown.status.success(), said(&unknown))?;
    ensure(!w.work().join("nobody").exists(), "a folder for nothing")?;
    ensure(!said(&unknown).contains("git clone -q"), said(&unknown))
}

#[test]
fn repo_remote_add_points_a_project_at_a_repository() -> TestResult {
    let w = World::new()?;
    let dir = w.project()?;
    let args = ["repo", "remote", "add", "origin", "ada/empty"];
    let added = w.yoneda(&dir, &args)?;
    ensure(added.status.success(), said(&added))?;
    let url = format!("yoneda::{}/ada/empty", w.origin);
    ensure(said(&added).contains(&url), said(&added))?;
    ensure(w.git(&dir, &["remote", "get-url", "origin"])? == url, "url")?;
    let status = w.yoneda(&dir, &["status"])?;
    ensure(status.status.success(), said(&status))?;
    ensure(said(&status).contains(EMPTY), said(&status))?;
    let again = w.yoneda(&dir, &args)?;
    ensure(again.status.success(), "the same remote twice is no error")
}

#[test]
fn repo_remote_add_replaces_a_remote_only_with_override() -> TestResult {
    let w = World::new()?;
    let dir = w.project()?;
    w.git(
        &dir,
        &["remote", "add", "origin", "https://example.test/x.git"],
    )?;
    let refused = w.yoneda(&dir, &["repo", "remote", "add", "origin", "ada/empty"])?;
    ensure(!refused.status.success(), said(&refused))?;
    ensure(said(&refused).contains("--override"), said(&refused))?;
    let kept = w.git(&dir, &["remote", "get-url", "origin"])?;
    ensure(kept == "https://example.test/x.git", kept)?;
    let args = ["repo", "remote", "add", "origin", "--override", "ada/other"];
    let replaced = w.yoneda(&dir, &args)?;
    ensure(replaced.status.success(), said(&replaced))?;
    let status = w.yoneda(&dir, &["status"])?;
    ensure(said(&status).contains(OTHER), said(&status))
}

#[test]
fn repo_remote_add_refuses_an_unknown_repository_and_a_plain_folder() -> TestResult {
    let w = World::new()?;
    let dir = w.project()?;
    let unknown = w.yoneda(&dir, &["repo", "remote", "add", "origin", "ada/nobody"])?;
    ensure(!unknown.status.success(), said(&unknown))?;
    ensure(
        said(&unknown).contains("not a repository you can read"),
        said(&unknown),
    )?;
    let remotes = w.git(&dir, &["remote"])?;
    ensure(remotes.is_empty(), remotes)?;
    let outside = w.yoneda(&w.work(), &["repo", "remote", "add", "origin", "ada/empty"])?;
    ensure(!outside.status.success(), said(&outside))?;
    ensure(said(&outside).contains("Git repository"), said(&outside))
}

#[test]
fn git_push_delete_removes_a_branch_and_refuses_one_that_is_not_there() -> TestResult {
    let w = World::new()?;
    let dir = w.project()?;
    let url = format!("yoneda::{}/ada/other", w.origin);
    w.git(&dir, &["remote", "add", "origin", &url])?;
    let gone = w.command("git", &dir, &["push", "origin", "--delete", "doomed"])?;
    ensure(gone.status.success(), said(&gone))?;
    let missing = w.command("git", &dir, &["push", "origin", "--delete", "nobody"])?;
    ensure(!missing.status.success(), said(&missing))
}

#[test]
fn completion_prints_a_script_each_shell_accepts() -> TestResult {
    let w = World::new()?;
    for (shell, check) in [("bash", "bash"), ("zsh", "zsh"), ("fish", "fish")] {
        let out = w.yoneda(&w.work(), &["completion", shell])?;
        ensure(out.status.success(), said(&out))?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        ensure(text.contains("clone"), text.clone())?;
        let file = w.work().join(format!("complete.{shell}"));
        std::fs::write(&file, &text).map_err(|e| e.to_string())?;
        let available = Command::new(check).arg("--version").output().is_ok();
        if available {
            let parsed = Command::new(check)
                .arg("-n")
                .arg(&file)
                .output()
                .map_err(|e| e.to_string())?;
            ensure(parsed.status.success(), said(&parsed))?;
        }
    }
    let powershell = w.yoneda(&w.work(), &["completion", "powershell"])?;
    ensure(
        said(&powershell).contains("Register-ArgumentCompleter"),
        said(&powershell),
    )?;
    let unknown = w.yoneda(&w.work(), &["completion", "tcsh"])?;
    ensure(unknown.status.code() == Some(64), said(&unknown))
}
