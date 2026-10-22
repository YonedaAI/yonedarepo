//! Attempt lifecycle instrumentation never records job payloads or raw errors.
use crate::{agent_transcript::Transcript, attempt_failure, broker::broker, jobs::execute_job};
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
    let progress = {
        let transcript = transcript.clone();
        move || {
            transcript
                .activity()
                .wrapping_add(crate::attempt_watchdog::signals())
        }
    };
    let heartbeat = tokio::spawn(heartbeat(progress.clone()).in_current_span());
    let result = match crate::execution_limits::limits(&job) {
        Ok(limits) => {
            tokio::select! {
                result = execute_job(&job, &transcript) => Ok(result),
                expiry = crate::attempt_watchdog::expired(limits, Duration::from_secs(1), progress) => Err(expiry),
            }
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
                error_message = %attempt_failure::detail(&error),
                duration_ms = started.elapsed().as_secs_f64() * 1000.0);
            let retryable =
                attempt_failure::disposition(job["kind"].as_str().unwrap_or_default(), &error)
                    .retryable();
            broker(
                "/failed",
                json!({"error":error.to_string(),"retryable":retryable}),
                true,
            )
            .await
        }
        Err(expiry) => {
            tracing::error!(
                event = "attempt.deadline",
                error_code = "EXECUTION_TIMEOUT",
                reason = if matches!(expiry, crate::attempt_watchdog::Expiry::Idle(_)) {
                    "idle"
                } else {
                    "ceiling"
                },
                duration_ms = started.elapsed().as_secs_f64() * 1000.0
            );
            report_deadline(
                (job["kind"] == "agent").then_some(&transcript),
                expiry,
                broker,
            )
            .await
        }
    };
    heartbeat.abort();
    if let Err(error) = report {
        tracing::error!(event = "attempt.callback_failed", error_code = %error.code,
            error_message = %attempt_failure::detail(&error));
    }
}

/// Every 20 s: tell the ledger whether this supervisor saw progress, and treat ledger-observed
/// model activity (including a request still waiting on the provider) as progress here.
async fn heartbeat(progress: impl Fn() -> u64) {
    let mut seen = progress();
    loop {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let current = progress();
        let active = current != seen;
        seen = current;
        match broker("/heartbeat", json!({"active":active}), true).await {
            Ok(lease) => {
                if lease["model_active"] == true {
                    crate::attempt_watchdog::note();
                    seen = progress();
                }
            }
            Err(_) => {
                tracing::error!(event = "attempt.heartbeat_failed");
                std::process::exit(2);
            }
        }
    }
}

/// Timeout has already dropped the harness and its process guards. Evidence must be attached
/// while the original attempt is still active, before failure makes it terminal.
pub(crate) async fn report_deadline<F, Fut>(
    transcript: Option<&Transcript>,
    expiry: crate::attempt_watchdog::Expiry,
    mut report: F,
) -> yoneda_agents_core::Result<Value>
where
    F: FnMut(&'static str, Value, bool) -> Fut,
    Fut: std::future::Future<Output = yoneda_agents_core::Result<Value>>,
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
                tracing::error!(event = "attempt.partial_evidence_failed", error_code = %error.code,
                    error_message = %attempt_failure::detail(&error))
            }
            Err(_) => tracing::error!(event = "attempt.partial_evidence_timeout"),
        }
    }
    report(
        "/failed",
        json!({"error":expiry.message(),"retryable":expiry.retryable()}),
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
) -> yoneda_agents_core::Result<Value>
where
    F: FnMut(&'static str, Value, bool) -> Fut,
    Fut: std::future::Future<Output = yoneda_agents_core::Result<Value>>,
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
