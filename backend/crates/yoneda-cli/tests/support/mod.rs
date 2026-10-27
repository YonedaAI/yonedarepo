//! A local source platform under workerd (`wrangler dev` with the platform-only test
//! Worker, the R2 object store and batched landing, as deployed; no provider keys), an
//! owner client acting as the other writer, and a runner for the `yoneda` binary.
pub mod proxy;

use base64::Engine;
use serde_json::{Value, json};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

pub type TestResult<T = ()> = Result<T, String>;

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn free_port() -> TestResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

pub struct Platform {
    child: Child,
    pub origin: String,
    pub owner: String,
    http: reqwest::Client,
    pub rt: tokio::runtime::Runtime,
    pub scratch: tempfile::TempDir,
}

impl Platform {
    pub fn start() -> TestResult<Self> {
        let root = repo_root();
        let wrangler = root.join("node_modules/.bin/wrangler");
        let build = root.join("backend/crates/yoneda-worker/build/index.js");
        for needed in [&wrangler, &build] {
            if !needed.exists() {
                return Err(format!(
                    "{} is missing: install the workspace's node modules and build the Rust Wasm worker first",
                    needed.display()
                ));
            }
        }
        let scratch = tempfile::tempdir().map_err(|e| e.to_string())?;
        let persist = scratch.path().join("state");
        let config = "tests/platform/wrangler.jsonc";
        // The platform's D1 schema, as the workerd fixture applies it: the repository
        // listing, personal-token lookup and membership index.
        for migration in [
            "0003_platform_repos.sql",
            "0004_platform_tokens.sql",
            "0005_platform_members.sql",
        ] {
            let schema = Command::new(&wrangler)
                .current_dir(&root)
                .args(["d1", "execute", "INDEX", "--local", "-c", config, "--file"])
                .arg(format!("cloudflare/migrations/{migration}"))
                .arg("--persist-to")
                .arg(&persist)
                .output()
                .map_err(|e| e.to_string())?;
            if !schema.status.success() {
                return Err(format!(
                    "D1 schema {migration}: {}",
                    String::from_utf8_lossy(&schema.stderr)
                ));
            }
        }
        let (port, inspector) = (free_port()?, free_port()?);
        let owner = uuid::Uuid::new_v4().simple().to_string();
        let log = std::fs::File::create(scratch.path().join("wrangler.log"))
            .map_err(|e| e.to_string())?;
        let child = Command::new(&wrangler)
            .current_dir(&root)
            .args(["dev", "-c", config, "--ip", "127.0.0.1"])
            .args([
                "--port",
                &port.to_string(),
                "--inspector-port",
                &inspector.to_string(),
            ])
            .arg("--persist-to")
            .arg(&persist)
            .args([
                "--var",
                "PLATFORM_OBJECT_STORE:r2",
                "--var",
                "LAND_MODE:batch",
            ])
            .args(["--var", &format!("OWNER_TOKEN:{owner}")])
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .spawn()
            .map_err(|e| e.to_string())?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let platform = Self {
            child,
            origin: format!("http://127.0.0.1:{port}"),
            owner,
            http: reqwest::Client::new(),
            rt,
            scratch,
        };
        platform.wait_ready()?;
        Ok(platform)
    }

    fn wait_ready(&self) -> TestResult {
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            if self.owner_call("GET", "/repos", None).is_ok() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let log =
            std::fs::read_to_string(self.scratch.path().join("wrangler.log")).unwrap_or_default();
        Err(format!("the local platform did not start:\n{log}"))
    }

    /// An owner API call (`/api/v1` + `path`); the owner plays the other writer.
    pub fn owner_call(&self, method: &str, path: &str, body: Option<Value>) -> TestResult<Value> {
        let url = format!("{}/api/v1{path}", self.origin);
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut request = self.http.request(method, url).bearer_auth(&self.owner);
        if let Some(body) = body {
            request = request.json(&body);
        }
        self.rt.block_on(async {
            let response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status();
            let value: Value = response.json().await.map_err(|e| e.to_string())?;
            if status.is_success() {
                Ok(value)
            } else {
                Err(format!("{path}: {status} {value}"))
            }
        })
    }

    /// A repository seeded with `files` (none: an empty repository, as `yoneda repo
    /// create` makes), and a token that may read, write and land.
    pub fn repo(&self, files: &[(&str, &str)]) -> TestResult<(String, String)> {
        let files: Vec<Value> = files.iter().map(|(p, t)| file(p, t)).collect();
        let mut body =
            json!({ "name": "cli", "policy": { "required_checks": [], "approvals": 0 } });
        if !files.is_empty() {
            body["files"] = json!(files);
            body["author"] = json!({ "name": "Seed", "email": "seed@example.com" });
        }
        let created = self.owner_call("POST", "/repos", Some(body))?;
        let id = created["id"].as_str().ok_or("no repo id")?.to_owned();
        let minted = self.owner_call(
            "POST",
            &format!("/repos/{id}/tokens"),
            Some(json!({ "name": "cli", "scopes": ["read", "write", "land"] })),
        )?;
        Ok((id, minted["token"].as_str().ok_or("no token")?.to_owned()))
    }

    /// The other writer commits `files` on main's head and lands it.
    pub fn other_writer(&self, repo: &str, files: &[(&str, &str)]) -> TestResult<Value> {
        let changes: Vec<Value> = files.iter().map(|(p, t)| file(p, t)).collect();
        let made = self.owner_call(
            "POST",
            &format!("/repos/{repo}/commits"),
            Some(
                json!({ "ref": "main", "changes": changes, "message": "other writer",
                         "author": { "name": "Other", "email": "other@example.com" } }),
            ),
        )?;
        let commit = made["commit"].as_str().ok_or("no commit")?;
        self.owner_call(
            "POST",
            &format!("/repos/{repo}/land"),
            Some(json!({ "ref": "main", "commit": commit })),
        )
    }

    /// A file on main's latest version.
    pub fn blob(&self, repo: &str, path: &str) -> TestResult<Value> {
        self.owner_call("GET", &format!("/repos/{repo}/blob?path={path}"), None)
    }

    /// Main's latest version, Git commit and tree.
    pub fn main(&self, repo: &str) -> TestResult<(u64, String, String)> {
        let refs = self.owner_call("GET", &format!("/repos/{repo}/refs"), None)?;
        let commit = refs["refs"]["refs/heads/main"]
            .as_str()
            .ok_or("no main")?
            .to_owned();
        let shown = self.owner_call("GET", &format!("/repos/{repo}/commits/{commit}"), None)?;
        let tree = shown["tree"].as_str().ok_or("no tree")?.to_owned();
        Ok((refs["version"].as_u64().ok_or("no version")?, commit, tree))
    }
}

impl Drop for Platform {
    fn drop(&mut self) {
        // An interrupt lets wrangler stop its workerd child; kill only as a last resort.
        let _ = Command::new("kill")
            .args(["-INT", &self.child.id().to_string()])
            .status();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
    }
}

pub fn file(path: &str, text: &str) -> Value {
    json!({ "path": path, "content_b64": base64::engine::general_purpose::STANDARD.encode(text) })
}

/// `PATH` with the built `git-remote-yoneda` first, as an installed helper would be.
fn helper_path() -> std::ffi::OsString {
    let helper = Path::new(env!("CARGO_BIN_EXE_git-remote-yoneda"));
    let mut dirs: Vec<PathBuf> = helper.parent().map(Path::to_path_buf).into_iter().collect();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Runs `yoneda` (or `git` when `program` is "git") in `dir` with an isolated config.
pub struct Client {
    pub home: PathBuf,
    pub token: String,
}

const IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Offline Dev"),
    ("GIT_AUTHOR_EMAIL", "dev@example.com"),
    ("GIT_COMMITTER_NAME", "Offline Dev"),
    ("GIT_COMMITTER_EMAIL", "dev@example.com"),
];

impl Client {
    fn command(&self, program: &str, dir: &Path) -> Command {
        let mut command = Command::new(program);
        command
            .current_dir(dir)
            .env("HOME", &self.home)
            .env_remove("CODEX_HOME")
            .env("XDG_CONFIG_HOME", self.home.join(".config"))
            .env("GIT_CONFIG_GLOBAL", self.home.join(".gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("YONEDA_TOKEN", &self.token)
            .envs(IDENTITY)
            .env("PATH", helper_path());
        command
    }

    /// Runs `git`, whatever its exit code.
    pub fn git_output(&self, dir: &Path, args: &[&str]) -> TestResult<Output> {
        self.command("git", dir)
            .args(args)
            .output()
            .map_err(|e| e.to_string())
    }

    /// `git` as a child of its own process group (so a test can kill git and the
    /// helper it started together).
    #[cfg(unix)]
    pub fn git_spawn(&self, dir: &Path, args: &[&str]) -> TestResult<Child> {
        use std::os::unix::process::CommandExt;
        self.command("git", dir)
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .map_err(|e| e.to_string())
    }

    pub fn yoneda(&self, dir: &Path, args: &[&str]) -> TestResult<Output> {
        self.command(env!("CARGO_BIN_EXE_yoneda"), dir)
            .args(args)
            .output()
            .map_err(|e| e.to_string())
    }

    /// Runs `yoneda`, requiring exit code 0; returns stdout.
    pub fn ok(&self, dir: &Path, args: &[&str]) -> TestResult<String> {
        let out = self.yoneda(dir, args)?;
        if !out.status.success() {
            return Err(format!(
                "yoneda {args:?} exited {:?}\nstdout: {}\nstderr: {}",
                out.status.code(),
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    pub fn git(&self, dir: &Path, args: &[&str]) -> TestResult<String> {
        let out = self
            .command("git", dir)
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    /// Writes `files` in `dir` and commits them offline with plain Git.
    pub fn commit(&self, dir: &Path, message: &str, files: &[(&str, &str)]) -> TestResult<String> {
        for (path, text) in files {
            let full = dir.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&full, text).map_err(|e| e.to_string())?;
        }
        self.git(dir, &["add", "-A"])?;
        self.git(dir, &["commit", "-q", "-m", message])?;
        self.git(dir, &["rev-parse", "HEAD"])
    }
}
