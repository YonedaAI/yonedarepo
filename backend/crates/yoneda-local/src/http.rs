//! Loopback smart HTTP at `/git/<repo>.git`, as the cloud serves it
//! (`cloudflare/worker/repo-git-http.ts`): a token as the Basic password (or a bearer),
//! checked by the authority on every request; push through `receive`, fetch through Git's
//! own backend. Without credentials Git is asked for them (401).
use crate::authority::Cred;
use crate::service::Service;
use crate::{backend, receive};
use axum::{
    Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use yoneda_core::{Error, Result};

/// The largest request: a push's pack (as the cloud holds) and its command list.
const MAX_BODY: usize = yoneda_platform::platform_git_receive::MAX_PACK_BYTES + (1 << 20);

pub fn router(svc: Arc<Service>) -> Router {
    Router::new()
        .route("/git/{repo}/info/refs", get(info_refs))
        .route("/git/{repo}/git-upload-pack", post(upload_pack))
        .route("/git/{repo}/git-receive-pack", post(receive_pack))
        .route("/local/sync", post(crate::sync_http::sync_now))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(svc)
}

fn status_of(code: &str) -> StatusCode {
    match code {
        "UNAUTHORIZED" => StatusCode::UNAUTHORIZED,
        "FORBIDDEN" => StatusCode::FORBIDDEN,
        "NOT_FOUND" | "GONE" => StatusCode::NOT_FOUND,
        "REPO_FULL" | "REPO_SIZE_LIMIT" => StatusCode::INSUFFICIENT_STORAGE,
        "LOCAL" => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    }
}

fn refusal(status: StatusCode, message: String) -> Response {
    let mut res = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8");
    if status == StatusCode::UNAUTHORIZED {
        res = res.header(header::WWW_AUTHENTICATE, "Basic realm=\"YonedaRepo local\"");
    }
    res.body(Body::from(format!("{message}\n")))
        .unwrap_or_default()
}

fn failed(e: &Error) -> Response {
    refusal(status_of(&e.code), format!("{}: {}", e.code, e.message))
}

/// The caller's token: the Basic password or a bearer.
fn credential(headers: &HeaderMap) -> Option<Cred> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    if let Some(basic) = value.strip_prefix("Basic ") {
        let decoded = String::from_utf8(STANDARD.decode(basic.trim()).ok()?).ok()?;
        let (_, password) = decoded.split_once(':')?;
        return (!password.is_empty()).then(|| Cred::Token(password.to_owned()));
    }
    value
        .strip_prefix("Bearer ")
        .map(|t| Cred::Token(t.trim().to_owned()))
}

/// Checks the path's repository and the caller's access, then runs `work` off the runtime.
async fn guarded(
    svc: Arc<Service>,
    repo: &str,
    headers: &HeaderMap,
    service: &'static str,
    work: impl FnOnce(&Service, &Cred) -> Result<Response> + Send + 'static,
) -> Response {
    let current = svc
        .layout
        .config()
        .map_or_else(|_| svc.config.repo.clone(), |c| c.repo);
    if repo.trim_end_matches(".git") != current {
        return refusal(StatusCode::NOT_FOUND, "Repository not found".into());
    }
    let Some(cred) = credential(headers) else {
        return refusal(
            StatusCode::UNAUTHORIZED,
            "Use the local token as the password".into(),
        );
    };
    let ran = tokio::task::spawn_blocking(move || {
        svc.authority.call(
            &cred,
            json!({ "op": "repo_git_access", "service": service }),
        )?;
        work(&svc, &cred)
    })
    .await;
    match ran {
        Ok(Ok(res)) => res,
        Ok(Err(e)) => failed(&e),
        Err(_) => refusal(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The request failed".into(),
        ),
    }
}

async fn info_refs(
    State(svc): State<Arc<Service>>,
    Path(repo): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let service = match query.get("service").map(String::as_str) {
        Some("git-upload-pack") => "git-upload-pack",
        Some("git-receive-pack") => "git-receive-pack",
        _ => return refusal(StatusCode::FORBIDDEN, "Smart HTTP only".into()),
    };
    let protocol = header_of(&headers, "git-protocol");
    guarded(svc, &repo, &headers, service, move |svc, cred| {
        if service == "git-receive-pack" {
            return crate::advertise::receive_pack(svc, cred);
        }
        let req = backend::Request {
            method: "GET",
            action: "info/refs",
            query: "service=git-upload-pack",
            content_type: None,
            content_encoding: None,
            git_protocol: protocol.as_deref(),
            body: &[],
        };
        Ok(cgi(backend::serve(&svc.store, &req)?))
    })
    .await
}

async fn upload_pack(
    State(svc): State<Arc<Service>>,
    Path(repo): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let content_type = header_of(&headers, "content-type");
    let encoding = header_of(&headers, "content-encoding");
    let protocol = header_of(&headers, "git-protocol");
    guarded(svc, &repo, &headers, "git-upload-pack", move |svc, _| {
        let req = backend::Request {
            method: "POST",
            action: "git-upload-pack",
            query: "",
            content_type: content_type.as_deref(),
            content_encoding: encoding.as_deref(),
            git_protocol: protocol.as_deref(),
            body: &body,
        };
        Ok(cgi(backend::serve(&svc.store, &req)?))
    })
    .await
}

async fn receive_pack(
    State(svc): State<Arc<Service>>,
    Path(repo): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if header_of(&headers, "content-encoding").is_some_and(|e| e != "identity") {
        return refusal(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Compressed pushes are not accepted".into(),
        );
    }
    guarded(
        svc,
        &repo,
        &headers,
        "git-receive-pack",
        move |svc, cred| {
            let report = receive::receive(svc, cred, &body)?;
            Ok(Response::builder()
                .header(
                    header::CONTENT_TYPE,
                    "application/x-git-receive-pack-result",
                )
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from(report))
                .unwrap_or_default())
        },
    )
    .await
}

fn header_of(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

fn cgi(answer: backend::Answer) -> Response {
    let mut res = Response::builder().status(answer.status);
    for (name, value) in answer.headers {
        res = res.header(name, value);
    }
    res.body(Body::from(answer.body)).unwrap_or_default()
}
