use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

/// A standard-1 container has one tokio worker: blocking source work must not stop the
/// heartbeat loop or the supervisor server that share it.
#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn blocking_source_work_leaves_the_async_worker_free() {
    let ticks = Arc::new(AtomicUsize::new(0));
    let counter = ticks.clone();
    let heartbeat = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(20)).await;
            counter.fetch_add(1, Ordering::SeqCst);
        }
    });
    // Like supervisor_task::spawn: the attempt runs as a task on the runtime's worker.
    let attempt = tokio::spawn(off_runtime(|| {
        std::thread::sleep(Duration::from_millis(400));
        Ok(7)
    }));
    let value = attempt.await.unwrap().unwrap();
    heartbeat.abort();
    assert_eq!(value, 7);
    assert!(
        ticks.load(Ordering::SeqCst) >= 5,
        "heartbeat starved: {} ticks",
        ticks.load(Ordering::SeqCst)
    );
}

#[tokio::test]
async fn blocking_source_failures_keep_their_code() {
    let error = off_runtime(|| Err::<(), _>(failure("SOURCE_IO", "fixture")))
        .await
        .unwrap_err();
    assert_eq!(error.code, "SOURCE_IO");
}
