//! Cloud sync: each local repository is paired with a cloud repository and kept in step
//! with it automatically: a round runs right after each landing on local `main`, every
//! 30 seconds (`YONEDA_LOCAL_SYNC_SECONDS`), and on `yoneda local sync`. A round pairs if
//! needed, brings cloud `main` down, pushes local `main` up, and brings down whatever the
//! cloud made of it (a cloud merge). Local acceptance and cloud publication stay separate
//! outcomes: nothing local is rolled back because the cloud refused it.
mod down;
mod pair;
pub mod state;
mod up;

use crate::authority::Cred;
use crate::cloud::Cloud;
use crate::layout::{Layout, local_error, write_private};
use crate::service::{PROJECTOR, Service};
use serde_json::json;
use state::{State, Sync};
use std::process::Output;
use std::sync::{Arc, mpsc};
use std::time::Duration;
use yoneda_core::{Result, git_object::ObjectId};

/// Why the sync thread wakes.
pub enum Kick {
    /// `main` landed locally.
    Landed,
    /// `yoneda local sync`: run a round now and answer its outcome.
    Now(mpsc::Sender<Sync>),
}

/// One round's surroundings.
pub struct Ctx<'a> {
    pub svc: &'a Service,
    pub layout: &'a Layout,
    pub cloud: Cloud,
    /// Sync's own principal for landing cloud `main` locally.
    pub cred: Cred,
}

/// Starts the sync thread: a round now, then on each kick or every interval.
pub fn start(svc: Arc<Service>) -> Result<mpsc::Sender<Kick>> {
    let (kicks, inbox) = mpsc::channel::<Kick>();
    let every = Duration::from_secs(
        std::env::var("YONEDA_LOCAL_SYNC_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .filter(|s| *s > 0)
            .unwrap_or(30),
    );
    std::thread::Builder::new()
        .name("sync".into())
        .spawn(move || {
            let mut asked: Vec<mpsc::Sender<Sync>> = Vec::new();
            loop {
                let outcome = round(&svc);
                for reply in asked.drain(..) {
                    let _ = reply.send(outcome.clone());
                }
                match inbox.recv_timeout(every) {
                    Ok(Kick::Now(reply)) => asked.push(reply),
                    Ok(Kick::Landed) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
                // Kicks that arrived meanwhile share the next round.
                while let Ok(kick) = inbox.try_recv() {
                    if let Kick::Now(reply) = kick {
                        asked.push(reply);
                    }
                }
            }
        })
        .map_err(|e| local_error(format!("Cannot start sync: {e}")))?;
    Ok(kicks)
}

/// Runs one round and records its outcome in `sync.json`.
pub fn round(svc: &Service) -> Sync {
    let layout = &svc.layout;
    let mut sync = Sync::load(layout);
    sync.state = State::Synced;
    sync.detail = None;
    if let Err(e) = steps(svc, layout, &mut sync) {
        sync.note(State::Pending, e.message);
    }
    if sync.state == State::Synced && unsynced(svc, sync.synced_version).unwrap_or(0) > 0 {
        sync.note(State::Pending, "local landings are not on the cloud yet");
    }
    sync.last_round_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    if let Err(e) = sync.save(layout) {
        eprintln!("yoneda-local: sync state not saved: {}", e.message);
    }
    sync
}

fn steps(svc: &Service, layout: &Layout, sync: &mut Sync) -> Result<()> {
    let Some(cloud) = pair::pair(svc, layout, sync)? else {
        return Ok(());
    };
    // Up pushes local `main` from the store, so its staged merges go there first.
    crate::outbox::drain(svc)?;
    let ctx = Ctx {
        svc,
        layout,
        cloud,
        cred: Cred::Token(sync_token(svc, layout)?),
    };
    down::down(&ctx, sync)?;
    if up::up(&ctx, sync)? {
        // The cloud may have merged local main with work of its own: bring that down.
        down::down(&ctx, sync)?;
        up::up(&ctx, sync)?;
    }
    Ok(())
}

/// Sync's repository token (scopes read, write, land), made on first use.
fn sync_token(svc: &Service, layout: &Layout) -> Result<String> {
    if let Ok(token) = std::fs::read_to_string(layout.sync_token()) {
        return Ok(token.trim().to_owned());
    }
    let token = crate::tokens::new_secret()?;
    svc.authority.call(
        &Cred::Owner,
        json!({ "op": "repo_token_create", "name": "cloud-sync",
                "scopes": ["read", "write", "land"], "_secret": token }),
    )?;
    write_private(&layout.sync_token(), token.as_bytes())?;
    Ok(token)
}

/// Local `main`, from the authority.
pub fn local_main(svc: &Service) -> Result<Option<ObjectId>> {
    let listed = svc
        .authority
        .call(&PROJECTOR, json!({ "op": "repo_refs" }))?;
    listed["refs"]["refs/heads/main"]
        .as_str()
        .map(ObjectId::parse)
        .transpose()
}

/// The local log's version.
pub fn main_version(svc: &Service) -> Result<u64> {
    let listed = svc
        .authority
        .call(&PROJECTOR, json!({ "op": "repo_refs" }))?;
    Ok(listed["version"].as_u64().unwrap_or(0))
}

/// Landings on local `main` after `version`.
pub fn unsynced(svc: &Service, version: u64) -> Result<u64> {
    let page = svc.authority.call(
        &PROJECTOR,
        json!({ "op": "repo_txlog", "after": version, "limit": 500 }),
    )?;
    Ok(page["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["refname"] == "refs/heads/main")
        .count() as u64)
}

/// A failed Git run against the cloud, in sync's terms.
pub fn classify(out: &Output) -> (State, String) {
    let err = String::from_utf8_lossy(&out.stderr);
    let lower = err.to_lowercase();
    let state = if [
        "authentication failed",
        "could not read username",
        "returned error: 401",
        "returned error: 403",
    ]
    .iter()
    .any(|m| lower.contains(m))
    {
        State::Refused
    } else if [
        "could not resolve",
        "failed to connect",
        "couldn't connect",
        "connection refused",
        "timed out",
        "unable to access",
    ]
    .iter()
    .any(|m| lower.contains(m))
    {
        State::Offline
    } else {
        State::Pending
    };
    let why = err
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty())
        .unwrap_or("git failed")
        .chars()
        .take(300)
        .collect();
    (state, why)
}
