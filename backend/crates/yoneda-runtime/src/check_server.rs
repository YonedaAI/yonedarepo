//! HTTP surface of the check executor inside the platform's check Container. One bearer
//! secret per container start; the Worker is the only caller.
use crate::{check_runner, err};
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
    Router::new()
        .route("/health", get(|| async { Json(json!({"check_runner": 1})) }))
        .route(
            "/check",
            post(move |headers: HeaderMap, body: axum::body::Bytes| {
                let secret = secret.clone();
                async move {
                    let authorized = !secret.is_empty()
                        && headers.get("authorization").and_then(|v| v.to_str().ok())
                            == Some(format!("Bearer {secret}").as_str());
                    if !authorized {
                        return (StatusCode::FORBIDDEN, Json(json!({"error": {"code": "FORBIDDEN"}})))
                            .into_response();
                    }
                    let request = match serde_json::from_slice(&body) {
                        Ok(request) => request,
                        Err(e) => {
                            return (StatusCode::BAD_REQUEST, Json(json!({"error": {"code": "INVALID_INPUT", "message": e.to_string()}})))
                                .into_response();
                        }
                    };
                    match check_runner::run(request).await {
                        Ok(result) => Json(result).into_response(),
                        Err(e) => (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({"error": {"code": e.code, "message": e.message}})))
                            .into_response(),
                    }
                }
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(BODY_LIMIT))
}

pub async fn serve_checks() -> Result<()> {
    let app = router(std::env::var("CHECK_TOKEN").unwrap_or_default());
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .map_err(err)?;
    axum::serve(listener, app).await.map_err(err)
}
