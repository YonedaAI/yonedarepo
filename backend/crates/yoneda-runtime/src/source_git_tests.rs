use crate::source_git::SourceGitObjects;
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "yoneda-source-git-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn fresh_store_rejects_existing_agent_repository_and_foreign_object_kinds() {
    let fixture = Fixture::new();
    assert!(
        SourceGitObjects::create(&fixture.0).is_err(),
        "cannot reuse an agent-controlled directory"
    );
    let mut store = SourceGitObjects::create(&fixture.0.join("trusted")).unwrap();
    assert!(store.write("tag", b"arbitrary agent object").is_err());
}

#[test]
fn changed_stream_requires_exact_sealed_size() {
    let fixture = Fixture::new();
    let mut store = SourceGitObjects::create(&fixture.0.join("capture")).unwrap();
    assert!(store.write_reader("blob", 2, b"abc".as_slice()).is_err());
    assert!(store.write_reader("blob", 4, b"abc".as_slice()).is_err());
    let good = store.write_reader("blob", 3, b"abc".as_slice()).unwrap();
    assert_eq!(good, store.write("blob", b"abc").unwrap());
}
