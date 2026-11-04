//! `yoneda local init`: gives the clone at the working directory its local repository.
//! It creates `.git/yoneda/local/` (store, authority, token, port), initializes the
//! repository with a local policy (no required checks or approvals: the cloud's policy
//! applies when work lands there), imports `main`'s history by pushing it through the same
//! receive path every push takes, and points the clone's remote `local` and its credential
//! helper at the service. Then it pairs with the cloud (`sync`): the clone's yoneda remote,
//! else a new cloud repository on the stored login's origin, which takes `main`'s history.
use crate::authority::Cred;
use crate::cloud::{self, Cloud};
use crate::layout::{Config, Layout, local_error, restrict, write_private};
use crate::receive;
use crate::service::Service;
use crate::store::{Store, run_in};
use crate::sync::state::Sync;
use serde_json::json;
use std::path::Path;
use yoneda_core::{Result, git_object::ObjectId, transport::receive_pack_request};

/// The token's repository name and scopes: fetch, push and land.
const TOKEN: &str = "local";

pub fn init(cwd: &Path) -> Result<String> {
    let layout = Layout::find(cwd)?;
    if let Ok(config) = layout.config() {
        return Ok(format!("Already set up: remote local at {}", config.url()));
    }
    let top = git_text(cwd, &["rev-parse", "--show-toplevel"])?;
    let paired = paired_remote(cwd);
    let config = Config {
        repo: match &paired {
            Some(cloud) => cloud.repo.clone(),
            None => new_repository_id()?,
        },
        port: free_port()?,
    };
    std::fs::create_dir_all(&layout.dir)
        .map_err(|e| local_error(format!("Cannot create {:?}: {e}", layout.dir)))?;
    restrict(&layout.dir)?;
    Store::create(&layout.store())?;
    let token = new_token()?;
    write_private(&layout.token(), token.as_bytes())?;
    layout.write_config(&config)?;
    let svc = Service::open(&layout)?;
    svc.authority.call(
        &Cred::Owner,
        json!({ "op": "repo_init", "name": name_of(&top), "object_store": "local:store.git",
                "policy": { "required_checks": [], "approvals": 0 } }),
    )?;
    svc.authority.call(
        &Cred::Owner,
        json!({ "op": "repo_token_create", "name": TOKEN, "scopes": ["read", "write", "land"],
                "_secret": token }),
    )?;
    let imported = import_main(&svc, cwd, &Cred::Token(token))?;
    configure_clone(cwd, &config)?;
    let sync = Sync {
        name: Some(name_of(&top)),
        paired: paired.is_some(),
        origin: paired.as_ref().map(|c| c.origin.clone()),
        repo: paired.map(|c| c.repo),
        ..Sync::default()
    };
    sync.save(&layout)?;
    let outcome = crate::sync::round(&svc);
    let url = layout.config().map_or_else(|_| config.url(), |c| c.url());
    let cloud = match (&outcome.origin, &outcome.repo, outcome.paired) {
        (Some(origin), Some(repo), true) => format!("paired with {origin} ({repo})"),
        _ => outcome
            .detail
            .clone()
            .unwrap_or_else(|| "not paired yet".into()),
    };
    let local = match imported {
        Some(tip) => format!("Local repository ready: main at {tip}, remote local at {url}"),
        None => format!("Local repository ready (empty), remote local at {url}"),
    };
    Ok(format!("{local}\ncloud: {cloud}"))
}

fn git_text(cwd: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&run_in(cwd, args, None)?)
        .trim()
        .to_owned())
}

/// The cloud repository the clone came from: its first yoneda remote (not `local`).
fn paired_remote(cwd: &Path) -> Option<Cloud> {
    let urls =
        run_in(cwd, &["config", "--get-regexp", r"^remote\..*\.url$"], None).unwrap_or_default();
    String::from_utf8_lossy(&urls).lines().find_map(|line| {
        let (key, url) = line.split_once(' ')?;
        if key == "remote.local.url" {
            return None;
        }
        let origin = cloud::origin_of(url)?;
        // A remote by name (`yoneda::<origin>/<handle>/<name>`) keeps its id in Git's config.
        let repo = cloud::repo_in(url).or_else(|| {
            let named = url
                .trim()
                .trim_start_matches("yoneda::")
                .trim_end_matches(".git");
            let key = format!("yoneda.{named}.id");
            let id = run_in(cwd, &["config", "--get", &key], None).ok()?;
            cloud::repo_in(String::from_utf8_lossy(&id).trim())
        })?;
        Some(Cloud { origin, repo })
    })
}

/// A new repository id, until pairing gives the cloud repository's.
fn new_repository_id() -> Result<String> {
    let mut bytes = [0u8; 10];
    getrandom::fill(&mut bytes).map_err(|e| local_error(format!("No randomness: {e}")))?;
    Ok(format!(
        "r{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

fn new_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| local_error(format!("No randomness: {e}")))?;
    Ok(format!(
        "ylt_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    ))
}

fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| local_error(format!("No free loopback port: {e}")))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| local_error(format!("No free loopback port: {e}")))
}

/// A repository name from the clone's directory, in the platform's alphabet.
fn name_of(top: &str) -> String {
    let base = Path::new(top)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("local");
    let name: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .take(100)
        .collect();
    let name = name.trim_start_matches('.').to_owned();
    if name.is_empty() {
        "local".into()
    } else {
        name
    }
}

/// Pushes the clone's `main` (or its checked-out commit) into the new repository.
fn import_main(svc: &Service, cwd: &Path, cred: &Cred) -> Result<Option<ObjectId>> {
    let tip = git_text(
        cwd,
        &["rev-parse", "--verify", "-q", "refs/heads/main^{commit}"],
    )
    .or_else(|_| git_text(cwd, &["rev-parse", "--verify", "-q", "HEAD^{commit}"]));
    let Ok(tip) = tip else {
        return Ok(None);
    };
    let tip = ObjectId::parse(&tip)?;
    let pack = run_in(
        cwd,
        &["pack-objects", "--revs", "--stdout", "-q"],
        Some(format!("{tip}\n").as_bytes()),
    )?;
    let body = receive_pack_request("refs/heads/main", None, tip, &pack)?;
    let report = receive::receive(svc, cred, &body)?;
    let text = String::from_utf8_lossy(&report);
    if !text.contains("ok refs/heads/main") {
        return Err(local_error(format!(
            "Importing main failed: {}",
            text.trim()
        )));
    }
    Ok(Some(tip))
}

/// Remote `local` and a credential helper that hands Git the token (never in the URL).
fn configure_clone(cwd: &Path, config: &Config) -> Result<()> {
    let url = config.url();
    if run_in(cwd, &["remote", "get-url", "local"], None).is_ok() {
        run_in(cwd, &["remote", "set-url", "local", &url], None)?;
    } else {
        run_in(cwd, &["remote", "add", "local", &url], None)?;
    }
    let exe =
        std::env::current_exe().map_err(|e| local_error(format!("Cannot find myself: {e}")))?;
    let helper = format!(
        "!'{}' credential",
        exe.display().to_string().replace('\'', r"'\''")
    );
    let key = format!("credential.{}.helper", config.origin());
    run_in(cwd, &["config", &key, &helper], None)?;
    Ok(())
}
