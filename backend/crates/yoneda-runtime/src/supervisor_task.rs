//! Attempt lifecycle instrumentation never records job payloads or raw errors.
use crate::{agent_transcript::Transcript, broker::broker, jobs::execute_job};
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
    let transcript = Transcript::default();
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
            tokio::time::timeout(
                Duration::from_millis(timeout),
                execute_job(&job, &transcript),
            )
            .await
        }
        Err(error) => Ok(Err(error)),
    };
    let report = match result {
        Ok(Ok(value)) => {
            tracing::info!(
                event = "attempt.finished",
                duration_ms = started.elapsed().as_secs_f64() * 1000.0
            );
            report_completion(
                value,
                job["kind"] == "evaluate",
                job["kind"] != "agent",
                broker,
            )
            .await
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
            report_deadline((job["kind"] == "agent").then_some(&transcript), broker).await
        }
    };
    heartbeat.abort();
    if let Err(error) = report {
        tracing::error!(event = "attempt.callback_failed", error_code = %error.code);
    }
}

/// Timeout has already dropped the harness and its process guards. Evidence must be attached
/// while the original attempt is still active, before failure makes it terminal.
pub(crate) async fn report_deadline<F, Fut>(
    transcript: Option<&Transcript>,
    mut report: F,
) -> yoneda_core::Result<Value>
where
    F: FnMut(&'static str, Value, bool) -> Fut,
    Fut: std::future::Future<Output = yoneda_core::Result<Value>>,
{
    if let Some(transcript) = transcript
        && !transcript.is_recorded()?
    {
        let evidence = transcript.partial_timeout()?;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            report("/evidence", json!({"content":evidence.to_string()}), true),
        )
        .await;
        match result {
            Ok(Ok(_)) => transcript.mark_recorded()?,
            Ok(Err(error)) => {
                tracing::error!(event = "attempt.partial_evidence_failed", error_code = %error.code)
            }
            Err(_) => tracing::error!(event = "attempt.partial_evidence_timeout"),
        }
    }
    report(
        "/failed",
        json!({"error":"EXECUTION_TIMEOUT: Execution deadline exceeded","retryable":false}),
        true,
    )
    .await
}

/// A rejected completion must close the original attempt through the failure path.
/// Callback acknowledgment loss also uses this path; the ledger fences already-completed jobs.
pub(crate) async fn report_completion<F, Fut>(
    value: Value,
    evaluation: bool,
    retryable: bool,
    mut report: F,
) -> yoneda_core::Result<Value>
where
    F: FnMut(&'static str, Value, bool) -> Fut,
    Fut: std::future::Future<Output = yoneda_core::Result<Value>>,
{
    let value = if evaluation {
        crate::report::bounded(value)
    } else {
        Ok(value)
    };
    let result = match value {
        Ok(value) => report("/complete", value, true).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            tracing::error!(event = "attempt.completion_rejected", error_code = %error.code);
            report(
                "/failed",
                json!({"error":error.to_string(),"retryable":retryable}),
                true,
            )
            .await
        }
    }
}
