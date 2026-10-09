use crate::err;
use serde_json::{Value, json};
use yoneda_core::Result;
pub(crate) fn health() -> Value {
    json!({"protocol":2,"capabilities":{"agent_delegation":1,"model_budgets":1,"max_execution_ms":yoneda_core::model_budget::MAX_MODEL_EXECUTION_MS,"optional_model_requests":1},"harnesses":["codex","claude","gemini"],"environment":yoneda_core::Policy::default().environment,"environments":[yoneda_core::Policy::default().environment,yoneda_core::build::ENVIRONMENT],"suites":["retry-contract-v1","retry-contract-v2","commands-v1"]})
}
pub async fn serve() -> Result<()> {
    #[cfg(target_os = "linux")]
    if unsafe { libc::geteuid() } != 0 {
        return Err(err("Container supervisor must own the isolated agent UID"));
    }
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::{get, post},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let started = Arc::new(AtomicBool::new(false));
    let app = Router::new()
        .route("/health", get(|| async { Json(health()) }))
        .route(
            "/job",
            post(move |headers: HeaderMap, Json(job): Json<Value>| {
                let started = started.clone();
                async move {
                    let secret = std::env::var("SUPERVISOR_TOKEN").unwrap_or_default();
                    if secret.is_empty()
                        || headers.get("authorization").and_then(|v| v.to_str().ok())
                            != Some(format!("Bearer {secret}").as_str())
                    {
                        return (StatusCode::FORBIDDEN, Json(json!({"error":"forbidden"})))
                            .into_response();
                    }
                    if !started.swap(true, Ordering::SeqCst) {
                        crate::supervisor_task::spawn(job);
                    }
                    (StatusCode::ACCEPTED, Json(json!({"status":"started"}))).into_response()
                }
            }),
        )
        .layer(axum::extract::DefaultBodyLimit::max(1024 * 1024));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .map_err(err)?;
    axum::serve(listener, app).await.map_err(err)
}
