//! `POST /local/sync`: `yoneda local sync` asking the running service for a round now. Only
//! the clone's own local token may ask; the answer is the round's outcome.
use crate::service::Service;
use crate::sync::Kick;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::sync::{Arc, mpsc};
use std::time::Duration;

/// How long a caller waits for the round (pairing pushes a whole history).
const ROUND_WAIT: Duration = Duration::from_secs(590);

pub async fn sync_now(State(svc): State<Arc<Service>>, headers: HeaderMap) -> Response {
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    let ran = tokio::task::spawn_blocking(move || {
        let token = svc.layout.read_token().ok()?;
        if !same(token.as_bytes(), presented.as_bytes()) {
            return None;
        }
        let (reply, answer) = mpsc::channel();
        let kicks = svc.sync.lock().unwrap_or_else(|e| e.into_inner()).clone()?;
        kicks.send(Kick::Now(reply)).ok()?;
        answer.recv_timeout(ROUND_WAIT).ok().map(Some)
    })
    .await;
    match ran {
        Ok(Some(Some(outcome))) => axum::Json(outcome).into_response(),
        Ok(Some(None)) | Err(_) => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        Ok(None) => StatusCode::UNAUTHORIZED.into_response(),
    }
}

/// Compares secrets without stopping at the first difference.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
