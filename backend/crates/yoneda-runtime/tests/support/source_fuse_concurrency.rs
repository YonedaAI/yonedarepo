//! Real kernel concurrency; the blocked backend models the root HTTP response boundary.
use super::*;
use source_client::{SourceBackend, SourceChange, SourceNode, SourceSlice};
use std::sync::{Mutex, mpsc};
use std::time::Duration;
use yoneda_agents_core::Result;

struct DelayedAck {
    base: Arc<MemorySource>,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
}
impl SourceBackend for DelayedAck {
    fn stat(&self, path: &str) -> Result<SourceNode> {
        self.base.stat(path)
    }
    fn list(&self, path: &str) -> Result<Vec<SourceNode>> {
        self.base.list(path)
    }
    fn read(&self, path: &str, version: u64, offset: u64, length: usize) -> Result<SourceSlice> {
        self.base.read(path, version, offset, length)
    }
    fn apply(&self, id: &str, change: &SourceChange) -> Result<Option<SourceNode>> {
        let result = self.base.apply(id, change);
        self.entered.send(()).unwrap();
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        result
    }
}

#[test]
#[ignore = "Actual Linux FUSE integration; run --test source_fuse -- --ignored"]
fn actual_linux_invalidation_during_inflight_kernel_write_does_not_deadlock_ack() {
    assert!(std::path::Path::new("/dev/fuse").exists());
    let base = MemorySource::new();
    let (entered, entry) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let backend = Arc::new(DelayedAck {
        base: base.clone(),
        entered,
        release: Mutex::new(wait),
    });
    let source = Arc::new(
        SourceWorkspace::new(
            backend,
            false,
            true,
            Arc::new(SourceCancellation::default()),
            1024,
        )
        .unwrap(),
    );
    let dir = tempfile::tempdir().unwrap();
    let mount = SourceMount::mount(source, dir.path()).unwrap();
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(dir.path().join("app.js"))
        .unwrap();
    let (written, write_result) = mpsc::channel();
    let writer = std::thread::spawn(move || {
        written.send(file.write_all(b"new")).unwrap();
    });
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    let invalidator = mount.invalidator();
    let (started, start) = mpsc::channel();
    let (invalidated, invalidate_result) = mpsc::channel();
    let notifier = std::thread::spawn(move || {
        started.send(()).unwrap();
        invalidated
            .send(invalidator.invalidate(&["app.js".into()]))
            .unwrap();
    });
    start.recv_timeout(Duration::from_secs(5)).unwrap();
    // Root filesystem HTTP must acknowledge without calling back into its active kernel write.
    // A simultaneous model-API invalidation may wait for the write, but holds no source lock.
    release.send(()).unwrap();
    write_result
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    invalidate_result
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    writer.join().unwrap();
    notifier.join().unwrap();
    assert_eq!(fs::read(dir.path().join("app.js")).unwrap(), b"new");
    assert_eq!(base.mutations(), 1);
    mount.close().unwrap();
}
