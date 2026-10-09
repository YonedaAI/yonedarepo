//! Attempt lifecycle instrumentation never records job payloads or raw errors.
use crate::{broker::broker, jobs::execute_job};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tracing::Instrument;

pub(crate) fn spawn(job: Value) {
    let span = tracing::info_span!(
        "attempt",
        job_id = job["id"].as_str().unwrap_or_default(),
        epoch = job["epoch"].as_i64().unwrap_or_default(),
        execution_id = job["payload"]["execution"]["id"]
            .as_str()
            .unwrap_or_default(),
        run_id = job["payload"]["execution"]["run_id"]
            .as_str()
            .unwrap_or_default(),
        kind = job["kind"].as_str().unwrap_or_default()
    );
    // Instrument the future, never hold Span::enter across an await.
    tokio::spawn(run(job).instrument(span));
}

async fn run(job: Value) {
    let started = Instant::now();
    tracing::info!(event = "attempt.started");
    let heartbeat = tokio::spawn(
        async {
            loop {
                tokio::time::sleep(Duration::from_secs(20)).await;
                if broker("/heartbeat", json!({}), true).await.is_err() {
                    tracing::error!(event = "attempt.heartbeat_failed");
                    std::process::exit(2);
                }
            }
        }
        .in_current_span(),
    );
    let result = match crate::execution_limits::timeout_ms(&job) {
        Ok(timeout) => {
            tokio::time::timeout(Duration::from_millis(timeout), execute_job(&job)).await
        }
        Err(error) => Ok(Err(error)),
    };
    let report = match result {
        Ok(Ok(value)) => {
            tracing::info!(
                event = "attempt.finished",
                duration_ms = started.elapsed().as_secs_f64() * 1000.0
            );
            broker("/complete", value, true).await
        }
        Ok(Err(error)) => {
            tracing::error!(event = "attempt.failed", error_code = %error.code,
                duration_ms = started.elapsed().as_secs_f64() * 1000.0);
            broker(
                "/failed",
                json!({"error":error.to_string(),"retryable":job["kind"]!="agent"}),
                true,
            )
            .await
        }
        Err(_) => {
            tracing::error!(
                event = "attempt.deadline",
                error_code = "EXECUTION_TIMEOUT",
                duration_ms = started.elapsed().as_secs_f64() * 1000.0
            );
            broker(
                "/failed",
                json!({"error":"EXECUTION_TIMEOUT: Execution deadline exceeded","retryable":false}),
                true,
            )
            .await
        }
    };
    heartbeat.abort();
    if let Err(error) = report {
        tracing::error!(event = "attempt.callback_failed", error_code = %error.code);
    }
}
