//! Read-only operator dashboard on the loopback listener. No Git credentials enter the
//! browser. Fixed Host and same-origin guards prevent DNS rebinding and browser requests
//! from other sites; Git and sync endpoints retain their separate token authentication.
pub mod activity;
mod data;
use crate::service::Service;
use axum::{
    Router,
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::get,
};
use std::sync::Arc;

pub fn routes() -> Router<Arc<Service>> {
    Router::new()
        .route("/", get(page))
        .route("/local/dashboard", get(snapshot))
        .route("/local/app.js", get(script))
        .route("/local/render.js", get(render))
        .route("/local/style.css", get(style))
        .route("/local/theme.css", get(theme))
        .route("/local/base.css", get(base))
        .route("/local/icon.svg", get(icon))
}
fn permitted(svc: &Service, h: &HeaderMap, data: bool) -> bool {
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if host != format!("127.0.0.1:{}", svc.config.port)
        && host != format!("localhost:{}", svc.config.port)
    {
        return false;
    }
    if let Some(origin) = h.get(header::ORIGIN)
        && origin.to_str().ok() != Some(format!("http://{host}").as_str())
    {
        return false;
    }
    // Top-level links may come from another site; they only serve the static shell.
    // Its data request is same-origin. Same-site requests from another port are refused.
    if data
        && h.get("sec-fetch-site")
            .is_some_and(|v| v != "same-origin" && v != "none")
    {
        return false;
    }
    true
}
fn answer(status: StatusCode, kind: &str, body: impl Into<Body>) -> Response {
    Response::builder().status(status)
        .header(header::CONTENT_TYPE,kind).header(header::CACHE_CONTROL,"no-store")
        .header("content-security-policy","default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
        .header("x-content-type-options","nosniff").header("referrer-policy","no-referrer")
        .header("cross-origin-resource-policy","same-origin")
        .body(body.into()).unwrap_or_default()
}
fn asset(svc: &Service, h: &HeaderMap, kind: &str, body: &'static str) -> Response {
    if !permitted(svc, h, false) {
        return answer(
            StatusCode::FORBIDDEN,
            "text/plain",
            "Open the local service directly.",
        );
    }
    answer(StatusCode::OK, kind, body)
}
async fn page(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    asset(
        &svc,
        &h,
        "text/html; charset=utf-8",
        include_str!("../../ui/index.html"),
    )
}
async fn script(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    asset(
        &svc,
        &h,
        "text/javascript; charset=utf-8",
        include_str!("../../ui/app.js"),
    )
}
async fn render(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    asset(
        &svc,
        &h,
        "text/javascript; charset=utf-8",
        include_str!("../../ui/render.js"),
    )
}
async fn style(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    asset(
        &svc,
        &h,
        "text/css; charset=utf-8",
        concat!(
            include_str!("../../ui/layout.css"),
            "\n",
            include_str!("../../ui/activity.css")
        ),
    )
}
async fn theme(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    asset(
        &svc,
        &h,
        "text/css; charset=utf-8",
        include_str!("../../../../../frontend/src/styles/theme.css"),
    )
}
async fn base(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    asset(
        &svc,
        &h,
        "text/css; charset=utf-8",
        include_str!("../../../../../frontend/src/styles/base.css"),
    )
}
async fn snapshot(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    if !permitted(&svc, &h, true) {
        return answer(
            StatusCode::FORBIDDEN,
            "text/plain",
            "Open the local service directly.",
        );
    }
    match tokio::task::spawn_blocking(move || data::snapshot(&svc)).await {
        Ok(Ok(data)) => match serde_json::to_string(&data) {
            Ok(json) => answer(StatusCode::OK, "application/json", json),
            Err(_) => answer(
                StatusCode::INTERNAL_SERVER_ERROR,
                "text/plain",
                "Could not read the local service.",
            ),
        },
        _ => answer(
            StatusCode::SERVICE_UNAVAILABLE,
            "text/plain",
            "Could not read the local service.",
        ),
    }
}

async fn icon(State(svc): State<Arc<Service>>, h: HeaderMap) -> Response {
    asset(
        &svc,
        &h,
        "image/svg+xml",
        include_str!("../../../../../frontend/public/favicon.svg"),
    )
}
