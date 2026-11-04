//! A throwaway clone with a local service, driven with real Git from linked worktrees.
//! Git runs with an isolated HOME and global config, so the developer's settings never
//! leak in. The service is a child process this test started; it is stopped only through
//! that handle (its own PID), never by name.
#![allow(dead_code)]

use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

pub struct Local {
    pub dir: tempfile::TempDir,
    pub clone: PathBuf,
    pub service: Option<Child>,
}

pub fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_yoneda-local")
}

impl Local {
    /// A clone whose `main` holds `a.txt`, `b.txt` and `list.txt`, set up by `init`.
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(
            home.join(".gitconfig"),
            "[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n",
        )
        .unwrap();
        let clone = dir.path().join("clone");
        let local = Self {
            dir,
            clone,
            service: None,
        };
        local.git_ok(local.dir.path(), &["init", "-q", "clone"]);
        local.write(&local.clone, "a.txt", "a\n");
        local.write(&local.clone, "b.txt", "b\n");
        local.write(&local.clone, "list.txt", "one\ntwo\nthree\n");
        local.git_ok(&local.clone, &["add", "."]);
        local.git_ok(&local.clone, &["commit", "-qm", "base"]);
        local.run_ok(&local.clone, &["init"]);
        local
    }

    pub fn home(&self) -> PathBuf {
        self.dir.path().join("home")
    }

    pub fn store(&self) -> PathBuf {
        self.clone.join(".git/yoneda/local/store.git")
    }

    fn env(&self, cmd: &mut Command) {
        cmd.env("HOME", self.home())
            .env("GIT_CONFIG_GLOBAL", self.home().join(".gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE");
    }

    pub fn git(&self, cwd: &Path, args: &[&str]) -> Output {
        let mut cmd = Command::new("git");
        cmd.args(args).current_dir(cwd);
        self.env(&mut cmd);
        cmd.output().unwrap()
    }

    pub fn git_ok(&self, cwd: &Path, args: &[&str]) -> String {
        let out = self.git(cwd, args);
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    pub fn run(&self, cwd: &Path, args: &[&str]) -> Output {
        let mut cmd = Command::new(bin());
        cmd.args(args).current_dir(cwd);
        self.env(&mut cmd);
        cmd.output().unwrap()
    }

    pub fn run_ok(&self, cwd: &Path, args: &[&str]) -> String {
        let out = self.run(cwd, args);
        assert!(
            out.status.success(),
            "yoneda-local {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_owned()
    }

    pub fn write(&self, dir: &Path, path: &str, text: &str) {
        std::fs::write(dir.join(path), text).unwrap();
    }

    /// Starts `serve` (with extra environment, e.g. a pause point) and waits until it
    /// listens.
    pub fn serve_with(&mut self, extra: &[(&str, &str)]) {
        let mut cmd = Command::new(bin());
        cmd.arg("serve")
            .current_dir(&self.clone)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        self.env(&mut cmd);
        for (k, v) in extra {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut line = String::new();
        BufReader::new(stdout).read_line(&mut line).unwrap();
        assert!(line.contains("listening"), "serve said: {line}");
        self.service = Some(child);
    }

    pub fn serve(&mut self) {
        self.serve_with(&[]);
    }

    /// Kills the service this test started, by its own handle.
    pub fn kill(&mut self) {
        if let Some(mut child) = self.service.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }

    /// A linked worktree on a new branch from the service's `main`.
    pub fn worktree(&self, name: &str) -> PathBuf {
        self.git_ok(&self.clone, &["fetch", "-q", "local"]);
        let path = self.dir.path().join(name);
        let p = path.to_str().unwrap();
        self.git_ok(
            &self.clone,
            &["worktree", "add", "-q", "-b", name, p, "local/main"],
        );
        path
    }

    pub fn commit(&self, wt: &Path, path: &str, text: &str) -> String {
        self.write(wt, path, text);
        self.git_ok(wt, &["add", path]);
        self.git_ok(wt, &["commit", "-qm", &format!("edit {path}")]);
        self.git_ok(wt, &["rev-parse", "HEAD"])
    }

    pub fn push(&self, wt: &Path, extra: &[&str]) -> Output {
        let mut args = vec!["push"];
        args.extend_from_slice(extra);
        args.extend_from_slice(&["local", "HEAD:refs/heads/main"]);
        self.git(wt, &args)
    }

    pub fn status(&self) -> Value {
        serde_json::from_str(&self.run_ok(&self.clone, &["status", "--json"])).unwrap()
    }

    pub fn store_ref(&self, name: &str) -> String {
        self.git_ok(&self.store(), &["rev-parse", name])
    }

    pub fn show(&self, rev_path: &str) -> String {
        self.git_ok(&self.store(), &["show", rev_path])
    }

    pub fn wait_for(path: &Path) {
        let start = Instant::now();
        while !path.exists() {
            assert!(
                start.elapsed() < Duration::from_secs(30),
                "{path:?} never appeared"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Local {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}
