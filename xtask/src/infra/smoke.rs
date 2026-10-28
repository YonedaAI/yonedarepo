//! `infra smoke`: the deployed stack serves the frontend, reports HEAD on every `/health`
//! and answers the owner on the agent API and the proxied platform API. Ephemeral envs
//! also create one repository (a write through the platform's DO, D1 and object store).
use super::inventory::{self, Deployable};
use super::spec::{Env, Lock, Spec};
use super::wrangler::table;
use crate::deploy_guard::{head, short};
use crate::process::Result;
use serde_json::{Value, json};
use std::time::Duration;

struct Check {
    rows: Vec<Vec<String>>,
    failed: usize,
}

impl Check {
    fn record(&mut self, name: &str, outcome: std::result::Result<String, String>) {
        let (state, detail) = match outcome {
            Ok(detail) => ("pass", detail),
            Err(detail) => {
                self.failed += 1;
                ("FAIL", detail)
            }
        };
        self.rows.push(vec![name.into(), state.into(), detail]);
    }
}

async fn call(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> std::result::Result<(u16, String), String> {
    let mut request = client.request(method, url);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status().as_u16();
    Ok((status, response.text().await.unwrap_or_default()))
}

fn expect_ok(
    result: std::result::Result<(u16, String), String>,
) -> std::result::Result<String, String> {
    match result? {
        (200, body) => Ok(body),
        (status, body) => Err(format!(
            "HTTP {status}: {}",
            body.chars().take(160).collect::<String>()
        )),
    }
}

/// The public front: the Worker that serves the frontend (the agents role, else the first).
fn front(workers: &[Deployable]) -> Option<&Deployable> {
    workers
        .iter()
        .find(|w| w.role == "agents" || w.role == "app")
        .or(workers.first())
}

pub(crate) async fn run(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let spec = Spec::load(&env)?;
    let workers = inventory::deployables(&spec, &Lock::load(&env)?)?;
    let owner = super::secrets::read(&spec.secrets_path())?
        .remove("OWNER_TOKEN")
        .ok_or("No OWNER_TOKEN in the secrets file")?;
    let head = head()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let mut check = Check {
        rows: Vec::new(),
        failed: 0,
    };
    let origin = front(&workers)
        .and_then(|w| w.health.as_ref().map(|(o, _)| o.clone()))
        .ok_or("No public front Worker in the spec")?;
    check.record(
        "frontend GET /",
        expect_ok(
            call(
                &client,
                reqwest::Method::GET,
                &format!("{origin}/"),
                None,
                None,
            )
            .await,
        )
        .and_then(|body| {
            if body.contains("<html") || body.contains("<!doctype") || body.contains("<!DOCTYPE") {
                Ok(format!("{origin}/ serves HTML"))
            } else {
                Err("200 without an HTML document".into())
            }
        }),
    );
    for worker in workers.iter().filter(|w| w.health.is_some()) {
        let live = crate::deploy_live::live_revision(worker).await;
        let outcome = match live.as_deref() {
            Some(revision) if revision == head => Ok(short(revision).to_owned()),
            other => Err(format!("{other:?}, expected {}", short(&head))),
        };
        check.record(&format!("{} /health = HEAD", worker.name), outcome);
    }
    check.record(
        "owner GET /api/v1/repos (platform proxy)",
        expect_ok(
            call(
                &client,
                reqwest::Method::GET,
                &format!("{origin}/api/v1/repos"),
                Some(&owner),
                None,
            )
            .await,
        )
        .map(|_| "200".into()),
    );
    if matches!(env, Env::Ephemeral(_)) {
        let created = expect_ok(
            call(
                &client,
                reqwest::Method::POST,
                &format!("{origin}/api/v1/repos"),
                Some(&owner),
                Some(json!({"name": format!("smoke-{}", short(&head))})),
            )
            .await,
        )
        .and_then(|body| {
            serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| v["id"].as_str().map(str::to_owned))
                .ok_or_else(|| "no repository id in the response".to_string())
        });
        check.record("owner POST /api/v1/repos", created.clone());
        if let Ok(id) = created {
            check.record(
                "owner GET /api/v1/repos/<new>",
                expect_ok(
                    call(
                        &client,
                        reqwest::Method::GET,
                        &format!("{origin}/api/v1/repos/{id}"),
                        Some(&owner),
                        None,
                    )
                    .await,
                )
                .map(|_| id),
            );
        }
    }
    table(
        &format!("{} smoke at {}", env.name(), short(&head)),
        &["Check", "Result", "Detail"],
        &check.rows,
    );
    if check.failed > 0 {
        return Err(format!("{} smoke check(s) failed", check.failed).into());
    }
    Ok(())
}
