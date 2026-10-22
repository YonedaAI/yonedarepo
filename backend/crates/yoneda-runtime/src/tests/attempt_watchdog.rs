use super::*;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

const LIMITS: Limits = Limits {
    idle: Some(Duration::from_secs(300)),
    ceiling: Duration::from_secs(1790),
};

#[tokio::test(start_paused = true)]
async fn a_progressing_attempt_runs_to_the_ceiling_not_the_old_ten_minute_wall_clock() {
    let progress = Arc::new(AtomicU64::new(0));
    let source = progress.clone();
    // The laundry attempts made a model request every 5-60 s; simulate output every 30 s.
    let ticker = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            source.fetch_add(1, Ordering::Relaxed);
        }
    });
    let started = Instant::now();
    let expiry = expired(LIMITS, Duration::from_secs(1), move || {
        progress.load(Ordering::Relaxed)
    })
    .await;
    ticker.abort();
    assert_eq!(expiry, Expiry::Ceiling(Duration::from_secs(1790)));
    assert!(started.elapsed() >= Duration::from_secs(1790));
    assert!(!expiry.retryable());
    assert!(expiry.message().contains("30 min safety ceiling"));
}

#[tokio::test(start_paused = true)]
async fn an_idle_attempt_stops_after_the_no_progress_window() {
    let progress = Arc::new(AtomicU64::new(0));
    let source = progress.clone();
    // Ten minutes of steady work, then silence.
    let ticker = tokio::spawn(async move {
        for _ in 0..20 {
            tokio::time::sleep(Duration::from_secs(30)).await;
            source.fetch_add(1, Ordering::Relaxed);
        }
    });
    let started = Instant::now();
    let expiry = expired(LIMITS, Duration::from_secs(1), move || {
        progress.load(Ordering::Relaxed)
    })
    .await;
    ticker.abort();
    assert_eq!(expiry, Expiry::Idle(Duration::from_secs(300)));
    let elapsed = started.elapsed().as_secs();
    assert!(
        (900..=902).contains(&elapsed),
        "stopped {elapsed}s after start"
    );
    assert!(expiry.retryable());
    assert!(
        expiry
            .message()
            .starts_with("EXECUTION_TIMEOUT: No agent progress for 5 min")
    );
}

#[tokio::test(start_paused = true)]
async fn non_agent_jobs_keep_their_wall_clock_limit() {
    let limits = Limits {
        idle: None,
        ceiling: Duration::from_secs(110),
    };
    let started = Instant::now();
    assert_eq!(
        expired(limits, Duration::from_secs(1), || 0).await,
        Expiry::Ceiling(Duration::from_secs(110))
    );
    assert_eq!(started.elapsed().as_secs(), 110);
}

#[test]
fn harness_output_and_source_requests_count_as_progress() {
    let transcript = crate::agent_transcript::Transcript::default();
    let before = transcript.activity();
    transcript
        .append(
            crate::agent_transcript::Channel::Stdout,
            b"{\"type\":\"assistant\"}\n",
        )
        .unwrap();
    assert!(transcript.activity() > before);
    let signals = super::signals();
    note();
    assert!(super::signals() > signals);
}
