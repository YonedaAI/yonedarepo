//! A read-only, allowlisted dashboard view. Never return tokens, policy commands,
//! check output, repository contents or the cloud's raw error diagnostics.
use crate::authority::Cred;
use crate::service::Service;
use crate::sync::state::Sync;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::Result;

#[derive(Serialize)]
pub struct Dashboard {
    pub repository: Repository,
    pub cloud: Cloud,
    pub landings: Vec<Landing>,
    pub refusals: Vec<super::activity::Refusal>,
    pub writers: Vec<Writer>,
    pub checks: Vec<Check>,
    pub branches: Vec<Branch>,
}
#[derive(Serialize)]
pub struct Repository {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub head: Option<String>,
    pub version: u64,
    pub url: String,
}
#[derive(Serialize)]
pub struct Cloud {
    pub state: crate::sync::state::State,
    pub enabled: bool,
    pub host: Option<String>,
    pub head: Option<String>,
}
#[derive(Serialize)]
pub struct Landing {
    pub version: u64,
    pub commit: String,
    pub actor: String,
    pub message: String,
    pub merged: bool,
    pub at_ms: i64,
}
#[derive(Serialize)]
pub struct Writer {
    pub name: String,
    pub landings: usize,
}
#[derive(Serialize)]
pub struct Check {
    pub name: String,
    pub status: String,
}
#[derive(Serialize)]
pub struct Branch {
    pub name: String,
    pub commit: String,
    pub integration: bool,
}

pub fn snapshot(svc: &Service) -> Result<Dashboard> {
    let status = svc
        .authority
        .call(&Cred::Owner, json!({"op":"repo_status"}))?;
    let refs = svc
        .authority
        .call(&Cred::Owner, json!({"op":"repo_refs"}))?;
    let version = refs["version"].as_u64().unwrap_or(0);
    let head = refs["refs"][svc.config.refname()]
        .as_str()
        .map(str::to_owned);
    let entries = svc.authority.call(
        &Cred::Owner,
        json!({"op":"repo_txlog","after":version.saturating_sub(200),"limit":200}),
    )?;
    let mut landings = Vec::new();
    let mut writers = BTreeMap::new();
    for e in entries["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .filter(|e| e["refname"] == svc.config.refname() && e["new"].is_string())
        .take(12)
    {
        let commit = e["new"].as_str().unwrap_or_default();
        let info = svc.authority.call(
            &Cred::Owner,
            json!({"op":"repo_commit","commit":commit,"ref":svc.config.branch}),
        )?;
        let actor = e["actor"].as_str().unwrap_or_default().to_owned();
        *writers.entry(actor.clone()).or_insert(0) += 1;
        landings.push(Landing {
            version: e["version"].as_u64().unwrap_or(0),
            commit: commit.to_owned(),
            actor,
            message: info["message"]
                .as_str()
                .unwrap_or("Accepted change")
                .lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(160)
                .collect(),
            merged: info["parents"].as_array().is_some_and(|p| p.len() > 1),
            at_ms: e["committed_at_ms"].as_i64().unwrap_or(0),
        });
    }
    let head_info = match &head {
        Some(commit) => svc.authority.call(
            &Cred::Owner,
            json!({"op":"repo_commit","commit":commit,"ref":svc.config.branch}),
        )?,
        None => Value::Null,
    };
    let mut checks = Vec::new();
    for name in status["policy"]["runners"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(n, _)| n)
        .take(30)
    {
        let mut latest = "not_run".to_owned();
        for run in head_info["check_runs"]
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .filter(|r| r["name"] == *name)
        {
            let detail = svc.authority.call(
                &Cred::Owner,
                json!({"op":"repo_check_run","run_id":run["id"]}),
            )?;
            if detail["policy_digest"] == status["policy_digest"] {
                latest = run["status"].as_str().unwrap_or("not_run").to_owned();
                break;
            }
        }
        checks.push(Check {
            name: name.clone(),
            status: latest,
        });
    }
    let common = svc
        .layout
        .common()
        .unwrap_or_else(|| svc.layout.dir.clone());
    let path = if common.file_name().is_some_and(|n| n == ".git") {
        common.parent().unwrap_or(&common)
    } else {
        &common
    };
    let sync = Sync::load(&svc.layout);
    let cloud_host = sync
        .origin
        .as_ref()
        .and_then(|s| reqwest::Url::parse(s).ok())
        .and_then(|u| u.host_str().map(str::to_owned));
    let sync_state = if svc.config.sync_enabled
        && sync.state == crate::sync::state::State::Synced
        && head != sync.cloud_main
    {
        crate::sync::state::State::Pending
    } else {
        sync.state
    };
    let branches = refs["refs"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, id)| {
            Some(Branch {
                name: name.strip_prefix("refs/heads/")?.to_owned(),
                commit: id.as_str()?.to_owned(),
                integration: name == &svc.config.refname(),
            })
        })
        .take(200)
        .collect();
    Ok(Dashboard {
        repository: Repository {
            name: status["name"]
                .as_str()
                .unwrap_or("Local repository")
                .to_owned(),
            path: path.display().to_string(),
            branch: svc.config.branch.clone(),
            head,
            version,
            url: svc.config.origin(),
        },
        cloud: Cloud {
            state: sync_state,
            enabled: svc.config.sync_enabled,
            host: cloud_host,
            head: sync.cloud_main,
        },
        landings,
        refusals: svc.activity.recent(),
        writers: writers
            .into_iter()
            .map(|(name, landings)| Writer { name, landings })
            .collect(),
        checks,
        branches,
    })
}
