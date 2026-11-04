//! `yoneda local init`: gives the clone at the working directory its local repository.
//! It creates `.git/yoneda/local/` (store, authority, token, port), initializes the
//! repository with a local policy (no required checks or approvals: the cloud's policy
//! applies when work lands there), imports `main`'s history by pushing it through the same
//! receive path every push takes, and points the clone's remote `local` and its credential
//! helper at the service. No network: pairing with the cloud is a separate step.
use crate::authority::Cred;
use crate::layout::{Config, Layout, local_error, restrict, write_private};
use crate::receive;
use crate::service::Service;
use crate::store::{Store, run_in};
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
    let config = Config {
        repo: repository_id(cwd)?,
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
    Ok(match imported {
        Some(tip) => format!(
            "Local repository ready: main at {tip}, remote local at {}",
            config.url()
        ),
        None => format!(
            "Local repository ready (empty), remote local at {}",
            config.url()
        ),
    })
}

fn git_text(cwd: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8_lossy(&run_in(cwd, args, None)?)
        .trim()
        .to_owned())
}

/// The paired cloud repository's id when the clone has a yoneda remote, else a new one.
fn repository_id(cwd: &Path) -> Result<String> {
    let urls =
        run_in(cwd, &["config", "--get-regexp", r"^remote\..*\.url$"], None).unwrap_or_default();
    for line in String::from_utf8_lossy(&urls).lines() {
        let url = line.split_once(' ').map_or("", |(_, u)| u);
        if let Some(id) = url.split(['/', ':', '.']).find(|part| {
            part.len() == 21
                && part.starts_with('r')
                && part[1..].bytes().all(|b| b.is_ascii_hexdigit())
        }) {
            return Ok(id.to_owned());
        }
    }
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
