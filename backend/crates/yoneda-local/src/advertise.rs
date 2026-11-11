//! `info/refs` for a push, from the authority (never the store's projection): compute's
//! `git_advertise` lists working branches and tags, and the integration branch's recent heads as `.have`
//! lines, so Git sends a protected branch's update as a creation the platform lands.
use crate::authority::Cred;
use crate::service::Service;
use axum::{body::Body, http::header, response::Response};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use yoneda_core::{Error, Result};

const RECENT: usize = 64;
const HISTORY: usize = 200;

pub fn receive_pack(svc: &Service, cred: &Cred) -> Result<Response> {
    let mut listed = svc.authority.call(cred, json!({ "op": "repo_refs" }))?;
    let mut haves: Vec<Value> = Vec::new();
    if listed["refs"][svc.config.refname()].is_string() {
        let log = svc.authority.call(
            cred,
            json!({ "op": "repo_log", "ref": svc.config.branch, "limit": HISTORY }),
        )?;
        haves = log["commits"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(i, _)| *i < RECENT || i.is_power_of_two())
            .map(|(_, c)| c["commit"].clone())
            .collect();
    }
    // Hide the integration ref from receive-pack, so stock Git sends stale work for
    // server-side landing rather than rejecting it locally as non-fast-forward.
    if let Some(refs) = listed["refs"].as_object_mut() {
        refs.remove(&svc.config.refname());
    }
    let answer = yoneda_platform::platform_compute(json!({
        "op": "git_advertise", "service": "git-receive-pack", "refs": listed["refs"],
        "annotated": listed["annotated"], "haves": haves,
    }))?;
    let body = STANDARD
        .decode(answer["body_b64"].as_str().unwrap_or_default())
        .map_err(|_| Error::new("LOCAL", "Unreadable advertisement"))?;
    Ok(Response::builder()
        .header(
            header::CONTENT_TYPE,
            "application/x-git-receive-pack-advertisement",
        )
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(body))
        .unwrap_or_default())
}
