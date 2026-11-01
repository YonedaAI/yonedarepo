//! HTTP surface of the check executor inside the platform's check Container. One bearer
//! secret per container start; the Worker is the only caller.
use crate::{check_runner, check_stream, err};
use serde_json::json;
use yoneda_core::Result;

const BODY_LIMIT: usize = 256 * 1024 * 1024;

pub(crate) fn router(secret: String) -> axum::Router {
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
    };
    let json_secret = secret.clone();
    Router::new()
        .route("/health", get(|| async { Json(json!({"check_runner": 1})) }))
        .route(
            "/check",
            post(move |headers: HeaderMap, body: axum::body::Bytes| {
                let secret = json_secret.clone();
                async move {
                    let arrived = std::time::Instant::now();
                    if !authorized(&secret, &headers) {
                        return forbidden();
                    }
                    let request = match serde_json::from_slice(&body) {
                        Ok(request) => request,
                        Err(e) => {
                            return (StatusCode::BAD_REQUEST, Json(json!({"error": {"code": "INVALID_INPUT", "message": e.to_string()}})))
                                .into_response();
                        }
                    };
                    answer(traced(&headers, check_runner::run(request, arrived)).await)
                }
            }),
        )
        .route(
            "/check/stream",
            post(move |headers: HeaderMap, body: axum::body::Body| {
                let secret = secret.clone();
                async move {
                    let arrived = std::time::Instant::now();
                    if !authorized(&secret, &headers) {
                        return forbidden();
                    }
                    let run = check_stream::run_stream(body.into_data_stream(), arrived);
                    answer(traced(&headers, run).await)
                }
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(BODY_LIMIT))
}

fn authorized(secret: &str, headers: &axum::http::HeaderMap) -> bool {
    !secret.is_empty()
        && headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {secret}").as_str())
}

/// The request this check descends from, as the Worker names it; only the characters an id
/// has reach a log line.
fn request_id(headers: &axum::http::HeaderMap) -> &str {
    headers
        .get("x-request-id")
        .and_then(|v| v.to_str().ok())
        .filter(|id| {
            id.len() <= 64
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
        .unwrap_or("")
}

/// `check`, with a line as it starts and ends that a Worker's log line can be matched to. The
/// outcome goes in the line, never what the check printed: that is the repository's content.
async fn traced<T>(
    headers: &axum::http::HeaderMap,
    check: impl Future<Output = Result<T>>,
) -> Result<T> {
    let request_id = request_id(headers);
    tracing::info!(event = "check.started", request_id);
    let result = check.await;
    match &result {
        Ok(_) => tracing::info!(event = "check.finished", request_id),
        Err(e) => tracing::warn!(event = "check.failed", request_id, error_code = %e.code),
    }
    result
}

fn forbidden() -> axum::response::Response {
    use axum::{Json, http::StatusCode, response::IntoResponse};
    (
        StatusCode::FORBIDDEN,
        Json(json!({"error": {"code": "FORBIDDEN"}})),
    )
        .into_response()
}

fn answer(result: Result<serde_json::Value>) -> axum::response::Response {
    use axum::{Json, http::StatusCode, response::IntoResponse};
    match result {
        Ok(result) => Json(result).into_response(),
        Err(e) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({"error": {"code": e.code, "message": e.message}})),
        )
            .into_response(),
    }
}

pub async fn serve_checks() -> Result<()> {
    let app = router(std::env::var("CHECK_TOKEN").unwrap_or_default());
    // The container listens on 8080; CHECK_LISTEN moves it for a local run beside others.
    let listen = std::env::var("CHECK_LISTEN").unwrap_or_else(|_| "0.0.0.0:8080".into());
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(err)?;
    axum::serve(listener, app).await.map_err(err)
}
