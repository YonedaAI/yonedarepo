//! A paired local repository and its cloud: either a second local service standing in for
//! the cloud (same smart HTTP and landing engine; fast, offline) or the hosted dev platform
//! (https://api.dev.yonedarepo.com, the owner's testing remote). Tokens travel only in the
//! environment of the processes this test starts; nothing here prints one.
#![allow(dead_code)]

use super::{Local, bin, text};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DEV: &str = "https://api.dev.yonedarepo.com";

pub enum Kind {
    Local,
    Dev,
}

pub struct Pair {
    pub client: Local,
    /// The stand-in cloud's own service (local kind only).
    pub cloud: Option<Local>,
    pub origin: String,
    /// The owner's token for this origin (dev) or the stand-in's local token.
    pub token: String,
    pub repo: String,
    /// A plain Git clone of the cloud repository, for landings made on the cloud.
    pub writer: PathBuf,
}

/// The owner's dev login, read from the real config directory (never printed).
pub fn dev_token() -> String {
    let home = std::env::var("HOME").expect("HOME");
    let path = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(home).join(".config"))
        .join("yoneda/credentials");
    let value: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).expect("sign in to dev first: yoneda login"),
    )
    .unwrap();
    assert_eq!(value["origin"], DEV, "the stored login must be for dev");
    value["token"].as_str().unwrap().to_owned()
}

/// `local-sync-test-<timestamp>-<n>`: the name of a fresh dev repository.
pub fn dev_name(n: u32) -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();
    format!("local-sync-test-{ts}-{n}")
}

impl Pair {
    /// A served client paired with a fresh cloud repository whose `main` holds the seed.
    pub fn new(kind: Kind, n: u32) -> Self {
        match kind {
            Kind::Local => Self::local(),
            Kind::Dev => Self::dev(n),
        }
    }

    fn local() -> Self {
        let mut cloud = Local::new();
        cloud.serve();
        let status = cloud.status();
        let url = status["url"].as_str().unwrap().to_owned();
        let origin = url.split("/git/").next().unwrap().to_owned();
        let repo = url
            .rsplit('/')
            .next()
            .unwrap()
            .trim_end_matches(".git")
            .to_owned();
        let token = std::fs::read_to_string(cloud.clone.join(".git/yoneda/local/token"))
            .unwrap()
            .trim()
            .to_owned();
        let env = [("YONEDA_TOKEN", token.as_str())];
        let client = Local::uninitialized("client", &env);
        let into = client.clone.to_str().unwrap().to_owned();
        let cloned = cloud_git(
            &client,
            client.dir.path(),
            &origin,
            &["clone", "-q", &url, &into],
        );
        assert!(cloned.status.success(), "{}", text(&cloned));
        Self::finish(client, Some(cloud), origin, token, repo)
    }

    fn dev(n: u32) -> Self {
        let token = dev_token();
        let env = [("YONEDA_TOKEN", token.as_str()), ("YONEDA_ORIGIN", DEV)];
        let client = Local::uninitialized(&dev_name(n), &env);
        client.seed();
        Self::finish(client, None, DEV.to_owned(), token, String::new())
    }

    fn finish(
        mut client: Local,
        cloud: Option<Local>,
        origin: String,
        token: String,
        repo: String,
    ) -> Self {
        let said = client.run_ok(&client.clone, &["init"]);
        assert!(said.contains("paired with"), "init said: {said}");
        client.serve();
        let repo = if repo.is_empty() {
            sync_json(&client)["sync"]["cloud"]["repo"]
                .as_str()
                .unwrap()
                .to_owned()
        } else {
            repo
        };
        let writer = client.dir.path().join("writer");
        let url = format!("{origin}/git/{repo}.git");
        let w = writer.to_str().unwrap().to_owned();
        let env_client = &client;
        let cloned = cloud_git(
            env_client,
            client.dir.path(),
            &origin,
            &["clone", "-q", &url, &w],
        );
        assert!(cloned.status.success(), "{}", text(&cloned));
        Self {
            client,
            cloud,
            origin,
            token,
            repo,
            writer,
        }
    }

    pub fn url(&self) -> String {
        format!("{}/git/{}.git", self.origin, self.repo)
    }

    /// Lands an edit on cloud `main` from the writer clone; answers the cloud's head.
    pub fn cloud_land(&self, path: &str, text_: &str) -> String {
        self.writer_git(&["pull", "-q", "--ff-only", "origin", "main"]);
        self.client.write(&self.writer, path, text_);
        self.client.git_ok(&self.writer, &["add", path]);
        self.client.git_ok(
            &self.writer,
            &["commit", "-qm", &format!("cloud edit {path}")],
        );
        let pushed = cloud_git(
            &self.client,
            &self.writer,
            &self.origin,
            &["push", "-q", "origin", "HEAD:refs/heads/main"],
        );
        assert!(pushed.status.success(), "{}", text(&pushed));
        self.cloud_main()
    }

    fn writer_git(&self, args: &[&str]) {
        let out = cloud_git(&self.client, &self.writer, &self.origin, args);
        assert!(out.status.success(), "{}", text(&out));
    }

    pub fn cloud_main(&self) -> String {
        let out = cloud_git(
            &self.client,
            self.client.dir.path(),
            &self.origin,
            &["ls-remote", &self.url(), "refs/heads/main"],
        );
        assert!(out.status.success(), "{}", text(&out));
        String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_owned()
    }

    /// Cloud `main`'s file `path`.
    pub fn cloud_show(&self, path: &str) -> String {
        self.writer_git(&["fetch", "-q", "origin", "main"]);
        self.client
            .git_ok(&self.writer, &["show", &format!("FETCH_HEAD:{path}")])
    }

    /// Subjects of cloud `main`'s history, newest first.
    pub fn cloud_log(&self) -> Vec<String> {
        self.writer_git(&["fetch", "-q", "origin", "main"]);
        self.client
            .git_ok(&self.writer, &["log", "--format=%s", "FETCH_HEAD"])
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// Lands an edit on local `main` from a new worktree; answers local `main`.
    pub fn local_land(&self, wt: &str, path: &str, text_: &str) -> String {
        let w = self.client.worktree(wt);
        self.client.commit(&w, path, text_);
        let pushed = self.client.push(&w, &[]);
        assert!(pushed.status.success(), "{}", text(&pushed));
        self.client.status()["main"].as_str().unwrap().to_owned()
    }

    pub fn sync(&self) -> Value {
        let out = self.client.run(&self.client.clone, &["sync", "--json"]);
        assert!(out.status.success(), "{}", text(&out));
        serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap()
    }

    /// Runs rounds until `done` holds (at most `rounds`); answers the last outcome.
    pub fn sync_until(&self, rounds: u32, done: impl Fn(&Value) -> bool) -> Value {
        let mut last = Value::Null;
        for _ in 0..rounds {
            last = self.sync();
            if done(&last) {
                return last;
            }
        }
        last
    }

    /// Waits up to `secs` for cloud `main` to be `want`.
    pub fn wait_cloud_main(&self, want: &str, secs: u64) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(secs) {
            if self.cloud_main() == want {
                return true;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        false
    }

    /// Restarts the client's service with `env` on top of its own.
    pub fn restart_client(&mut self, env: &[(&str, &str)]) {
        self.client.kill();
        self.client.serve_with(env);
    }

    /// A dev repository token for this repository (`read`, `write`, `land`).
    pub fn dev_token_create(&self, name: &str) -> String {
        let made: Value = reqwest::blocking::Client::new()
            .post(format!("{DEV}/api/v1/repos/{}/tokens", self.repo))
            .bearer_auth(&self.token)
            .json(&json!({ "name": name, "scopes": ["read", "write", "land"] }))
            .send()
            .unwrap()
            .json()
            .unwrap();
        made["token"].as_str().expect("no token made").to_owned()
    }

    pub fn dev_token_revoke(&self, name: &str) {
        let res = reqwest::blocking::Client::new()
            .delete(format!("{DEV}/api/v1/repos/{}/tokens/{name}", self.repo))
            .bearer_auth(&self.token)
            .send()
            .unwrap();
        assert!(res.status().is_success(), "revoke: {}", res.status());
    }
}

pub fn sync_json(local: &Local) -> Value {
    serde_json::from_str(&local.run_ok(&local.clone, &["status", "--json"])).unwrap()
}

/// Git against the cloud with the service's own cloud credential helper (the token comes
/// from `YONEDA_TOKEN` in the client's environment).
pub fn cloud_git(client: &Local, cwd: &Path, origin: &str, args: &[&str]) -> Output {
    let helper = format!("credential.helper=!'{}' credential cloud", bin());
    let mut cmd = Command::new("git");
    cmd.args(["-c", "credential.helper=", "-c", &helper])
        .args(args)
        .current_dir(cwd)
        .env("HOME", client.home())
        .env("GIT_CONFIG_GLOBAL", client.home().join(".gitconfig"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("XDG_CONFIG_HOME")
        .env("YONEDA_LOCAL_CLOUD", origin);
    for (k, v) in &client.extra {
        cmd.env(k, v);
    }
    cmd.output().unwrap()
}
