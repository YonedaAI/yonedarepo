//! `status` and `sync`: what the local repository holds and where its cloud copy stands,
//! shown as two separate outcomes (accepted locally; published to the cloud).
use crate::layout::{Layout, local_error};
use crate::lock;
use crate::service::Service;
use crate::sync::{self, state::Sync};
use serde_json::{Value, json};
use std::path::Path;
use yoneda_core::Result;

pub fn status(cwd: &Path, as_json: bool) -> Result<String> {
    let layout = Layout::find(cwd)?;
    let svc = Service::open(&layout)?;
    show(&svc, &Sync::load(&layout), as_json)
}

/// Runs a sync round: in the running service when there is one (it owns the store), else
/// in this process.
pub fn sync_now(cwd: &Path, as_json: bool) -> Result<String> {
    let layout = Layout::find(cwd)?;
    let config = layout.config()?;
    let outcome = match lock::take(&layout) {
        Ok(_held) => sync::round(&Service::open(&layout)?),
        Err(_) => ask_service(&layout, config.port)?,
    };
    show(&Service::open(&layout)?, &outcome, as_json)
}

fn ask_service(layout: &Layout, port: u16) -> Result<Sync> {
    let answer = reqwest::blocking::Client::new()
        .post(format!("http://127.0.0.1:{port}/local/sync"))
        .bearer_auth(layout.read_token()?)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .map_err(|e| local_error(format!("The service did not answer: {}", e.without_url())))?;
    if !answer.status().is_success() {
        return Err(local_error(format!(
            "The service refused the sync: {}",
            answer.status()
        )));
    }
    answer
        .json()
        .map_err(|_| local_error("The service's answer was unreadable"))
}

fn show(svc: &Service, sync: &Sync, as_json: bool) -> Result<String> {
    let main = sync::local_main(svc)?.map(|m| m.to_string());
    let version = sync::main_version(svc)?;
    let unsynced = sync::unsynced(svc, sync.synced_version)?;
    let cloud = sync.repo.as_ref().map(|r| {
        json!({ "origin": sync.origin, "repo": r, "main": sync.cloud_main, "paired": sync.paired })
    });
    let url = svc
        .layout
        .config()
        .map_or_else(|_| svc.config.url(), |c| c.url());
    if as_json {
        return Ok(json!({
            "main": main, "version": version, "url": url,
            "sync": { "state": sync.state, "detail": sync.detail, "unsynced": unsynced,
                      "last_round_ms": sync.last_round_ms, "cloud": cloud.unwrap_or(Value::Null) },
        })
        .to_string());
    }
    let state = serde_json::to_value(sync.state)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let mut lines = vec![
        format!("local main: {}", main.as_deref().unwrap_or("(empty)")),
        format!("log version: {version}"),
        format!("remote local: {url}"),
        format!("cloud sync: {state}"),
    ];
    if let (Some(origin), Some(repo)) = (&sync.origin, &sync.repo) {
        lines.push(format!("cloud repository: {origin} ({repo})"));
        lines.push(format!(
            "cloud main: {}",
            sync.cloud_main.as_deref().unwrap_or("(empty)")
        ));
    }
    lines.push(format!("landings not on the cloud yet: {unsynced}"));
    if let Some(detail) = &sync.detail {
        lines.push(format!("detail: {detail}"));
    }
    Ok(lines.join("\n"))
}
