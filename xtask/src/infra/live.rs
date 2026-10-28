//! Read-only snapshot of an account's live resources through the Cloudflare REST API.
//!
//! The token comes from `CLOUDFLARE_API_TOKEN` or from `--token-file <KEY=VALUE file>`; it is
//! held in memory only. A section that cannot be read is recorded in `errors`, so a plan
//! never reports "unchanged" for something it did not see.
use super::retired::Kind;
use super::spec::Spec;
use crate::process::Result;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const API: &str = "https://api.cloudflare.com/client/v4";

#[derive(Clone, Debug, Default)]
pub(crate) struct LiveWorker {
    pub settings: Value,
    pub secrets: BTreeSet<String>,
    pub migration_tag: Option<String>,
    pub workers_dev: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Live {
    pub d1: BTreeMap<String, String>,
    pub r2: BTreeSet<String>,
    /// Queue name -> consumer scripts.
    pub queues: BTreeMap<String, BTreeSet<String>>,
    pub workflows: BTreeSet<String>,
    /// Container application name -> application.
    pub containers: BTreeMap<String, Value>,
    pub workers: BTreeMap<String, LiveWorker>,
    /// Zone route pattern -> script.
    pub routes: BTreeMap<String, String>,
    /// Custom domain hostname -> service.
    pub domains: BTreeMap<String, String>,
    /// The spec zone's id, and the ids of its routes and the account's custom domains (for
    /// detaching a host from the Worker that holds it, `hosts`).
    pub zone_id: Option<String>,
    pub route_ids: BTreeMap<String, String>,
    pub domain_ids: BTreeMap<String, String>,
    /// Retired Artifacts namespace -> its repositories (read only for `retired.artifacts`).
    pub artifacts: BTreeMap<String, Vec<String>>,
    /// Sections that could not be read.
    pub errors: Vec<String>,
}

pub(crate) fn token(args: &[String]) -> Result<String> {
    if let Some(path) = args
        .windows(2)
        .find(|v| v[0] == "--token-file")
        .map(|v| &v[1])
    {
        return super::secrets::read(std::path::Path::new(path))?
            .remove("CLOUDFLARE_API_TOKEN")
            .ok_or_else(|| format!("{path} has no CLOUDFLARE_API_TOKEN").into());
    }
    std::env::var("CLOUDFLARE_API_TOKEN").map_err(|_| {
        "Live reads need a read-only API token: set CLOUDFLARE_API_TOKEN or pass --token-file <file>".into()
    })
}

pub(crate) struct Client {
    http: reqwest::Client,
    token: String,
}

impl Client {
    pub(crate) fn new(token: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            token,
        }
    }
    pub(crate) async fn get(&self, path: &str) -> Result<Value> {
        self.send(reqwest::Method::GET, path).await
    }
    pub(crate) async fn send(&self, method: reqwest::Method, path: &str) -> Result<Value> {
        let response = self
            .http
            .request(method.clone(), format!("{API}{path}"))
            .bearer_auth(&self.token)
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() || body["success"] != Value::Bool(true) {
            let codes: Vec<String> = body["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|e| format!("{} {}", e["code"], e["message"].as_str().unwrap_or("")))
                .collect();
            return Err(format!("{method} {path}: HTTP {status} {}", codes.join("; ")).into());
        }
        Ok(body)
    }
    /// All pages of a listing whose `result` is an array.
    pub(crate) async fn list(&self, path: &str) -> Result<Vec<Value>> {
        let separator = if path.contains('?') { '&' } else { '?' };
        let mut all = Vec::new();
        for page in 1..=50 {
            let body = self
                .get(&format!("{path}{separator}page={page}&per_page=100"))
                .await?;
            let items = body["result"].as_array().cloned().unwrap_or_default();
            let count = items.len();
            all.extend(items);
            let pages = body["result_info"]["total_pages"].as_u64().unwrap_or(1);
            if count == 0 || page >= pages {
                break;
            }
        }
        Ok(all)
    }
}

fn names(items: &[Value], field: &str) -> BTreeSet<String> {
    items
        .iter()
        .filter_map(|v| v[field].as_str().map(str::to_owned))
        .collect()
}

/// Reads every section the spec can declare, for the given Worker names.
pub(crate) async fn read(spec: &Spec, token: String, workers: &[String]) -> Live {
    let client = Client::new(token);
    let account = format!("/accounts/{}", spec.account_id);
    let mut live = Live::default();
    macro_rules! section {
        ($label:expr, $body:expr) => {
            if let Err(error) = $body {
                live.errors.push(format!("{}: {error}", $label));
            }
        };
    }
    section!(
        "D1",
        async {
            for db in client.list(&format!("{account}/d1/database")).await? {
                if let (Some(name), Some(id)) = (db["name"].as_str(), db["uuid"].as_str()) {
                    live.d1.insert(name.into(), id.into());
                }
            }
            Result::Ok(())
        }
        .await
    );
    section!(
        "R2",
        async {
            let body = client
                .get(&format!("{account}/r2/buckets?per_page=1000"))
                .await?;
            live.r2 = names(
                body["result"]["buckets"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                "name",
            );
            Result::Ok(())
        }
        .await
    );
    section!(
        "Queues",
        async {
            for queue in client.list(&format!("{account}/queues")).await? {
                let Some(name) = queue["queue_name"].as_str() else {
                    continue;
                };
                let consumers = queue["consumers"].as_array().cloned().unwrap_or_default();
                let scripts = consumers
                    .iter()
                    .filter_map(|c| {
                        c["script"]
                            .as_str()
                            .or(c["service"].as_str())
                            .map(str::to_owned)
                    })
                    .collect();
                live.queues.insert(name.into(), scripts);
            }
            Result::Ok(())
        }
        .await
    );
    section!(
        "Workflows",
        async {
            live.workflows = names(&client.list(&format!("{account}/workflows")).await?, "name");
            Result::Ok(())
        }
        .await
    );
    let rest = async {
        let mut apps = BTreeMap::new();
        for app in client
            .list(&format!("{account}/containers/applications"))
            .await?
        {
            if let Some(name) = app["name"].as_str() {
                apps.insert(name.to_owned(), app.clone());
            }
        }
        Result::Ok(apps)
    }
    .await;
    // The Containers API needs its own token permission; wrangler's login can read it too.
    section!(
        "Containers",
        rest.or_else(|_| containers_via_wrangler(spec))
            .map(|apps| live.containers = apps)
    );
    section!(
        "Workers",
        read_workers(&client, &account, workers, &mut live.workers).await
    );
    super::hosts::read(&client, spec, &mut live).await;
    live
}

async fn read_workers(
    client: &Client,
    account: &str,
    wanted: &[String],
    out: &mut BTreeMap<String, LiveWorker>,
) -> Result<()> {
    let scripts = client.get(&format!("{account}/workers/scripts")).await?;
    for script in scripts["result"].as_array().into_iter().flatten() {
        let Some(name) = script["id"].as_str() else {
            continue;
        };
        let tracked = wanted.iter().any(|w| w == name);
        let mut worker = LiveWorker {
            migration_tag: script["migration_tag"].as_str().map(str::to_owned),
            ..LiveWorker::default()
        };
        if tracked {
            let base = format!("{account}/workers/scripts/{name}");
            worker.settings = client.get(&format!("{base}/settings")).await?["result"].clone();
            worker.secrets = names(
                client.get(&format!("{base}/secrets")).await?["result"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
                "name",
            );
            worker.workers_dev =
                client.get(&format!("{base}/subdomain")).await?["result"]["enabled"].as_bool();
        }
        out.insert(name.into(), worker);
    }
    Ok(())
}

/// Applications under the env's prefix or retired, with `max_instances` and
/// `configuration.image`.
fn containers_via_wrangler(spec: &Spec) -> Result<BTreeMap<String, Value>> {
    let account = &spec.account_id;
    let list: Value = serde_json::from_slice(&super::wrangler::output(
        account,
        &["containers", "list", "--json", "--per-page", "100"],
    )?)?;
    let mut apps = BTreeMap::new();
    for app in list.as_array().into_iter().flatten() {
        let (Some(name), Some(id)) = (app["name"].as_str(), app["id"].as_str()) else {
            continue;
        };
        if name.starts_with(&format!("{}-", spec.prefix))
            || spec.retired.matches(Kind::Container, name)
        {
            let info = super::wrangler::output(account, &["containers", "info", id, "--json"])?;
            apps.insert(name.to_owned(), serde_json::from_slice(&info)?);
        }
    }
    Ok(apps)
}
