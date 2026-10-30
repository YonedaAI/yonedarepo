//! `yoneda <command> --json`: every command that prints a result prints exactly one JSON
//! document on stdout, `{ "schema": "yoneda.cli.<command>.v1", "data": ... }`, valid
//! against the committed `schemas/v1/<command>.schema.json`; a failure prints the
//! `yoneda.cli.error.v1` document with a stable code and keeps its exit code. Without
//! `--json` the human output is unchanged (byte for byte). The built binary runs against
//! a canned local platform (`mock`) and throwaway Git repositories; no network, no keys.
mod mock;
mod validate;

use mock::{COMMIT, FORK, REPO};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

type TestResult<T = ()> = Result<T, String>;

/// `ssh-keygen -lf` of the fixture key in `work/id.pub`.
const SSH_FINGERPRINT: &str = "+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU";

fn schemas_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../schemas/v1")
}

fn pretty(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

/// A throwaway home, a plain directory and a clone with a `yoneda::` remote.
struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
    origin: String,
}

fn git(dir: &Path, args: &[&str]) -> TestResult {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    out.status
        .success()
        .then_some(())
        .ok_or_else(|| String::from_utf8_lossy(&out.stderr).into_owned())
}

impl World {
    fn new() -> TestResult<Self> {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let root = std::fs::canonicalize(dir.path()).map_err(|e| e.to_string())?;
        let origin = mock::start()?;
        for sub in ["config", "home/.ssh", "work", "clone/src", "bin"] {
            std::fs::create_dir_all(root.join(sub)).map_err(|e| e.to_string())?;
        }
        let clone = root.join("clone");
        std::fs::write(clone.join("src/a.rs"), "fn a() {}\n").map_err(|e| e.to_string())?;
        git(&clone, &["init", "-q", "-b", "main"])?;
        git(
            &clone,
            &[
                "remote",
                "add",
                "origin",
                &format!("yoneda::{origin}/{REPO}"),
            ],
        )?;
        git(&clone, &["add", "-A"])?;
        git(
            &clone,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
        )?;
        std::fs::write(
            root.join("work/id.pub"),
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ci@box\n",
        )
        .map_err(|e| e.to_string())?;
        std::fs::write(root.join("work/app.zip"), "zip").map_err(|e| e.to_string())?;
        std::fs::copy(
            root.join("work/id.pub"),
            root.join("home/.ssh/id_ed25519.pub"),
        )
        .map_err(|e| e.to_string())?;
        // `ssh setup` finds these first, never the real clipboard, tunnel or network.
        for (name, script) in [
            ("pbcopy", "cat >/dev/null"),
            ("cloudflared", "exit 0"),
            (
                "ssh",
                "echo \"Hi ci! You've successfully authenticated\" >&2; exit 1",
            ),
        ] {
            let path = root.join("bin").join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(Self {
            _dir: dir,
            root,
            origin,
        })
    }

    /// Runs `yoneda args` in `dir` (`work` or `clone`) with `stdin`.
    fn run(&self, dir: &str, args: &[String], stdin: &str) -> TestResult<Output> {
        let path = format!(
            "{}:{}",
            self.root.join("bin").display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut child = Command::new(env!("CARGO_BIN_EXE_yoneda"))
            .args(args)
            .current_dir(self.root.join(dir))
            .env("HOME", self.root.join("home"))
            .env("PATH", path)
            .env("XDG_CONFIG_HOME", self.root.join("config"))
            .env("YONEDA_TOKEN", "ydt_fixture")
            .env_remove("YONEDA_ORIGIN")
            .env_remove("CODEX_HOME")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut input) = child.stdin.take() {
            input
                .write_all(stdin.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        child.wait_with_output().map_err(|e| e.to_string())
    }

    /// Stdout with this world's paths and origin as `{TMP}` and `{ORIGIN}`.
    fn generic(&self, out: &[u8]) -> String {
        String::from_utf8_lossy(out)
            .replace(&self.root.display().to_string(), "{TMP}")
            .replace(&self.origin, "{ORIGIN}")
    }
}

/// One command: where it runs, its arguments (`{ORIGIN}` and `{TMP}` expanded), its
/// schema name, and its human stdout (`None`: not compared, e.g. time-dependent text).
struct Case {
    dir: &'static str,
    line: &'static str,
    schema: &'static str,
    human: Option<String>,
    stdin: &'static str,
}

fn case(line: &'static str, schema: &'static str, human: impl Into<String>) -> Case {
    Case {
        dir: "work",
        line,
        schema,
        human: Some(human.into()),
        stdin: "",
    }
}

fn in_clone(line: &'static str, schema: &'static str, human: Option<&str>) -> Case {
    Case {
        dir: "clone",
        line,
        schema,
        human: human.map(str::to_owned),
        stdin: "",
    }
}

fn cases() -> Vec<Case> {
    let release_line = "v1 First (ccccccc) by alice, 1 asset(s)";
    let change_line = "#3 [open] Retry twice (topic -> main) by alice";
    vec![
        case(
            "repo list --origin {ORIGIN}",
            "repo-list",
            format!("{REPO}  demo  private  1700000000000\n"),
        ),
        case(
            "repo create demo --origin {ORIGIN}",
            "repo-create",
            format!("Created private demo ({REPO})\n  git clone yoneda::{{ORIGIN}}/{REPO}\n"),
        ),
        case(
            "repo visibility {REPO} public --origin {ORIGIN}",
            "repo-visibility",
            format!("{REPO} is now public\n"),
        ),
        case(
            "repo delete {REPO} --confirm demo --origin {ORIGIN}",
            "repo-delete",
            format!("Deleted {REPO} (demo)\n"),
        ),
        case(
            "repo fork {REPO} --name mine --origin {ORIGIN}",
            "repo-fork",
            format!(
                "Forked {REPO} at version 7 as mine ({FORK}): 2 ref(s), 5 commit(s)\n  git clone yoneda::{{ORIGIN}}/{FORK}\nnext: push a branch, then yoneda change create <branch> --to-parent\n"
            ),
        ),
        case("org list --origin {ORIGIN}", "org-list", "acme  owner\n"),
        case(
            "org create acme --origin {ORIGIN}",
            "org-create",
            "Created organization acme (you are its owner)\n",
        ),
        case(
            "org show acme --origin {ORIGIN}",
            "org-show",
            "acme  (you: owner, created by alice)\nmembers:\n  alice  owner\nteams:\n  devs  [alice]\n",
        ),
        case(
            "org repos acme --origin {ORIGIN}",
            "org-repos",
            format!("{REPO}  demo\n"),
        ),
        case(
            "org delete acme --confirm acme --origin {ORIGIN}",
            "org-delete",
            "Deleted organization acme; its name is retired\n",
        ),
        case(
            "org member add acme bob --origin {ORIGIN}",
            "org-member-add",
            "bob is now member of acme\n",
        ),
        case(
            "org member remove acme bob --origin {ORIGIN}",
            "org-member-remove",
            "Removed bob from acme (and its teams)\n",
        ),
        case(
            "org team create acme devs --origin {ORIGIN}",
            "org-team-create",
            "Created team acme/devs; grant it on a repository as team:acme/devs\n",
        ),
        case(
            "org team delete acme devs --origin {ORIGIN}",
            "org-team-delete",
            "Deleted team acme/devs\n",
        ),
        case(
            "org team add acme devs bob --origin {ORIGIN}",
            "org-team-add",
            "Added bob to acme/devs\n",
        ),
        case(
            "org team remove acme devs bob --origin {ORIGIN}",
            "org-team-remove",
            "Removed bob from acme/devs\n",
        ),
        case(
            "ssh-key add id.pub --title ci --origin {ORIGIN}",
            "ssh-key-add",
            "Added k1 SHA256:abc  ci\nThen: git clone ssh://git@ssh.example/<repository id>.git\n",
        ),
        case(
            "ssh setup --origin {ORIGIN}",
            "ssh-setup",
            format!(
                "Added SHA256:{SSH_FINGERPRINT} to your account\n\
                 Routed ssh.example in {{TMP}}/home/.ssh/config\n\
                 Your public key, copied to the clipboard with pbcopy:\n\
                 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl ci@box\n\
                 ssh -T git@ssh.example: Hi ci! You've successfully authenticated\n\
                 Clone: git clone ssh://git@ssh.example/{REPO}.git demo\n"
            ),
        ),
        case(
            "ssh-key list --origin {ORIGIN}",
            "ssh-key-list",
            "k1  SHA256:abc  ci  last used never\n",
        ),
        case(
            "ssh-key remove k1 --origin {ORIGIN}",
            "ssh-key-remove",
            "Removed SSH key k1; Git over SSH with it stops at once\n",
        ),
        case(
            "token create ci --repo {REPO} --origin {ORIGIN}",
            "token-create",
            "ydr_fixture_secret\n",
        ),
        case(
            "token list --repo {REPO} --origin {ORIGIN}",
            "token-list",
            pretty(&mock::tokens()),
        ),
        case(
            "token revoke ci --repo {REPO} --origin {ORIGIN}",
            "token-revoke",
            "Revoked ci\n",
        ),
        case(
            "check run lint --commit {COMMIT} --repo {REPO} --origin {ORIGIN}",
            "check-run",
            pretty(&mock::check_run()),
        ),
        case(
            "check status run1 --repo {REPO} --origin {ORIGIN}",
            "check-status",
            pretty(&mock::check_run()),
        ),
        case(
            "check status --commit {COMMIT} --repo {REPO} --origin {ORIGIN}",
            "check-status",
            pretty(
                &json!({ "commit": COMMIT, "checks": {}, "check_runs": [], "gates": { "ready": true } }),
            ),
        ),
        case(
            "log --repo {REPO} --origin {ORIGIN}",
            "log",
            format!("{COMMIT} v3 first\n"),
        ),
        case(
            "grep needle --repo {REPO} --origin {ORIGIN}",
            "grep",
            "src/a.rs:3: fn main\n",
        ),
        case(
            "blame src/a.rs --repo {REPO} --origin {ORIGIN}",
            "blame",
            pretty(&mock::blame()),
        ),
        case(
            "diff --repo {REPO} --origin {ORIGIN}",
            "diff",
            "--- a/a.txt\n+++ b/a.txt\nD b.txt\n",
        ),
        case(
            "symbols src/a.rs --repo {REPO} --origin {ORIGIN}",
            "symbols",
            pretty(&mock::symbols()),
        ),
        case(
            "land --branch topic --repo {REPO} --origin {ORIGIN}",
            "land",
            format!("Landed topic ({COMMIT}) on main at version 9\n"),
        ),
        case(
            "rebase topic --repo {REPO} --origin {ORIGIN}",
            "rebase",
            format!("Rebased topic onto main: 1 commit(s) replayed, now at {COMMIT}\n"),
        ),
        case(
            "review approve {COMMIT} --repo {REPO} --origin {ORIGIN}",
            "review",
            format!("Recorded approve on {COMMIT}\n"),
        ),
        case(
            "policy show --repo {REPO} --origin {ORIGIN}",
            "policy-show",
            pretty(&mock::status()["policy"]),
        ),
        case(
            "policy set {\"approvals\":1} --repo {REPO} --origin {ORIGIN}",
            "policy-set",
            pretty(&json!({ "policy": { "approvals": 1 } })),
        ),
        case(
            "change create topic --title Retry_twice --repo {REPO} --origin {ORIGIN}",
            "change-create",
            format!(
                "Opened {change_line}\nnext: yoneda review approve {COMMIT} (a reviewer), then yoneda change land 3\n"
            ),
        ),
        case(
            "change list --repo {REPO} --origin {ORIGIN}",
            "change-list",
            format!("{change_line}\n"),
        ),
        case(
            "change show 3 --repo {REPO} --origin {ORIGIN}",
            "change-show",
            format!(
                "{change_line}\n\n  why\n\nhead {COMMIT}\nnot ready: approvals 0/1; waiting for ci\n  approve by bob\n1 file(s) changed\n  modify src/a.rs\n- bob on src/a.rs:7 (new)\n  nit\n"
            ),
        ),
        case(
            "change comment 3 -m hi --repo {REPO} --origin {ORIGIN}",
            "change-comment",
            "Commented on change #3\n",
        ),
        case(
            "change land 3 --repo {REPO} --origin {ORIGIN}",
            "change-land",
            format!("Landed change #3 ({COMMIT}) on main at version 9\n"),
        ),
        case(
            "release list --repo {REPO} --origin {ORIGIN}",
            "release-list",
            format!("{release_line}\n"),
        ),
        case(
            "release show v1 --repo {REPO} --origin {ORIGIN}",
            "release-show",
            format!("{release_line}\n  app.zip 3 bytes sha256 ab\n"),
        ),
        case(
            "release create v1 --asset app.zip --repo {REPO} --origin {ORIGIN}",
            "release-create",
            format!("Published {release_line}\nUploaded app.zip (3 bytes, sha256 ab)\n"),
        ),
        case(
            "session record {COMMIT} --cli codex --summary done --repo {REPO} --origin {ORIGIN}",
            "session-record",
            format!("Recorded session 5 for {COMMIT}\n"),
        ),
        case(
            "session list {COMMIT} --repo {REPO} --origin {ORIGIN}",
            "session-list",
            "codex gpt by alice\n  done\n",
        ),
        case(
            "setup codex --origin {ORIGIN}",
            "setup",
            "Wrote {TMP}/home/.codex/config.toml\nWrote {TMP}/home/.agents/skills/yoneda/SKILL.md\nMCP server: {ORIGIN}/api/v1/mcp\nThe agent reads the token from $YONEDA_TOKEN (`yoneda login`, then export it).\n",
        ),
        Case {
            stdin: "ydt_stored\n",
            ..case(
                "login --with-token --origin {ORIGIN}",
                "login",
                "Stored a token for {ORIGIN} in {TMP}/config/yoneda/credentials (mode 0600)\n",
            )
        },
        case(
            "logout",
            "logout",
            "Removed the stored token ({TMP}/config/yoneda/credentials)\n",
        ),
        in_clone(
            "reads add src/a.rs",
            "reads-add",
            Some("1 new read(s) declared; 1 in all\n"),
        ),
        in_clone("reads list", "reads-list", Some("src/a.rs\n")),
        in_clone(
            "reads clear",
            "reads-clear",
            Some("Declared reads cleared\n"),
        ),
        in_clone(
            "conflicts",
            "conflicts",
            Some("No refused landing recorded\n"),
        ),
        in_clone(
            "status --brief",
            "status",
            Some(&format!(
                "yoneda {REPO} at {{ORIGIN}} | main: 1 commit(s) not on the platform\n"
            )),
        ),
        in_clone(
            "status",
            "status",
            Some(&format!(
                "yoneda {REPO} at {{ORIGIN}} | main: 1 commit(s) not on the platform\n"
            )),
        ),
        in_clone("context", "context", None),
    ]
}

impl World {
    fn args(&self, line: &str) -> Vec<String> {
        line.split_whitespace()
            .map(|a| {
                a.replace("{ORIGIN}", &self.origin)
                    .replace("{COMMIT}", COMMIT)
                    .replace("{REPO}", REPO)
                    .replace('_', " ")
            })
            .collect()
    }
}

/// The one JSON document on stdout, checked against its committed schema.
fn json_document(out: &Output, schema: &str) -> TestResult<Value> {
    let text = String::from_utf8_lossy(&out.stdout);
    let document: Value = serde_json::from_str(&text)
        .map_err(|e| format!("stdout is not one JSON document ({e}): {text:?}"))?;
    let expected = format!("yoneda.cli.{schema}.v1");
    if document["schema"] != expected.as_str() {
        return Err(format!("schema {} is not {expected}", document["schema"]));
    }
    let file = schemas_dir().join(format!("{schema}.schema.json"));
    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?,
    )
    .map_err(|e| e.to_string())?;
    let errors = validate::errors(&committed, &committed, &document, "$");
    if !errors.is_empty() {
        return Err(format!("{schema}: {errors:#?}\n{text}"));
    }
    Ok(document)
}

#[test]
fn every_result_prints_its_human_text_or_one_schema_valid_json_document() -> TestResult {
    let world = World::new()?;
    let mut failures = Vec::new();
    for case in cases() {
        let args = world.args(case.line);
        let human = world.run(case.dir, &args, case.stdin)?;
        let stdout = world.generic(&human.stdout);
        if !human.status.success() {
            failures.push(format!(
                "{}: {}",
                case.line,
                String::from_utf8_lossy(&human.stderr)
            ));
            continue;
        }
        if let Some(expected) = &case.human
            && &stdout != expected
        {
            failures.push(format!(
                "{}: human output changed:\n{stdout:?}\n!=\n{expected:?}",
                case.line
            ));
        }
        let mut json_args = args.clone();
        json_args.push("--json".into());
        let json = world.run(case.dir, &json_args, case.stdin)?;
        if !json.status.success() {
            failures.push(format!(
                "{} --json: {}",
                case.line,
                String::from_utf8_lossy(&json.stderr)
            ));
            continue;
        }
        if let Err(e) = json_document(&json, case.schema) {
            failures.push(format!("{} --json: {e}", case.line));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n\n"))
    }
}

#[test]
fn failures_print_the_error_document_and_keep_their_exit_codes() -> TestResult {
    let world = World::new()?;
    for (line, code, exit, platform) in [
        ("repo bogus --origin {ORIGIN}", "usage", 64, None),
        (
            "land --branch main --repo {REPO} --origin {ORIGIN}",
            "usage",
            64,
            None,
        ),
        (
            "org show nobody --origin {ORIGIN}",
            "not_found",
            1,
            Some("NOT_FOUND"),
        ),
        (
            "land --branch clash --repo {REPO} --origin {ORIGIN}",
            "conflict",
            2,
            Some("CONFLICT"),
        ),
    ] {
        let args = world.args(line);
        let human = world.run("work", &args, "")?;
        let mut json_args = args.clone();
        json_args.push("--json".into());
        let json = world.run("work", &json_args, "")?;
        for out in [&human, &json] {
            if out.status.code() != Some(exit) {
                return Err(format!("{line}: exit {:?}, not {exit}", out.status.code()));
            }
        }
        // Human mode: the message on stderr, nothing on stdout (as before --json existed).
        if !human.stdout.is_empty()
            || !String::from_utf8_lossy(&human.stderr).starts_with("yoneda: ")
        {
            return Err(format!("{line}: human error output changed: {human:?}"));
        }
        let document = json_document(&json, "error")?;
        let data = &document["data"];
        if data["code"] != code
            || data["exit_code"] != exit
            || data["platform_code"].as_str() != platform
        {
            return Err(format!("{line}: {document}"));
        }
        let message = String::from_utf8_lossy(&human.stderr);
        if data["message"]
            .as_str()
            .map(|m| format!("yoneda: {m}\n"))
            .as_deref()
            != Some(&*message)
        {
            return Err(format!(
                "{line}: the JSON message differs from the human one: {document} / {message:?}"
            ));
        }
    }
    Ok(())
}

/// The schema check is not vacuous: an extra field, a wrong type and a wrong id fail it.
#[test]
fn the_schema_check_refuses_documents_that_drift() -> TestResult {
    let file = schemas_dir().join("repo-delete.schema.json");
    let schema: Value =
        serde_json::from_str(&std::fs::read_to_string(file).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let good =
        json!({ "schema": "yoneda.cli.repo-delete.v1", "data": { "id": REPO, "name": "demo" } });
    if !validate::errors(&schema, &schema, &good, "$").is_empty() {
        return Err("a valid document failed".into());
    }
    for bad in [
        json!({ "schema": "yoneda.cli.repo-delete.v1", "data": { "id": REPO, "name": "demo", "extra": 1 } }),
        json!({ "schema": "yoneda.cli.repo-delete.v1", "data": { "id": 7, "name": "demo" } }),
        json!({ "schema": "yoneda.cli.repo-delete.v2", "data": { "id": REPO, "name": "demo" } }),
        json!({ "schema": "yoneda.cli.repo-delete.v1", "data": { "id": REPO } }),
    ] {
        if validate::errors(&schema, &schema, &bad, "$").is_empty() {
            return Err(format!("{bad} passed"));
        }
    }
    Ok(())
}
