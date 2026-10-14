#![cfg(target_os = "linux")]
#![allow(dead_code)]
#[path = "support/source_fuse_concurrency.rs"]
mod concurrency;
#[path = "../src/source_client.rs"]
mod source_client;
#[path = "../src/source_client_api.rs"]
mod source_client_api;
#[path = "../src/source_fs.rs"]
mod source_fs;
#[path = "../src/source_workspace.rs"]
mod source_workspace;
#[path = "../src/source_workspace_directories.rs"]
mod source_workspace_directories;
#[path = "../src/source_workspace_eval.rs"]
mod source_workspace_eval;
#[path = "../src/source_workspace_job.rs"]
mod source_workspace_job;
#[path = "../src/source_workspace_registry.rs"]
mod source_workspace_registry;
#[path = "../src/source_workspace_scratch.rs"]
mod source_workspace_scratch;
#[path = "../src/source_workspace_session.rs"]
mod source_workspace_session;
mod support;
use source_client::SourceCancellation;
use source_fs::SourceMount;
use source_workspace::SourceWorkspace;
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    os::{fd::AsRawFd, unix::fs::PermissionsExt},
    process::Command,
    sync::Arc,
};
use support::MemorySource;

fn mounted(
    server: &Arc<MemorySource>,
    readonly: bool,
) -> (tempfile::TempDir, SourceMount, Arc<SourceWorkspace>) {
    assert!(
        std::path::Path::new("/dev/fuse").exists(),
        "Actual Linux /dev/fuse required; no mock substitute"
    );
    let dir = tempfile::tempdir().unwrap();
    let source = Arc::new(
        SourceWorkspace::new(
            server.clone(),
            readonly,
            true,
            Arc::new(SourceCancellation::default()),
            1024,
        )
        .unwrap(),
    );
    let mount = SourceMount::mount(source.clone(), dir.path()).unwrap();
    (dir, mount, source)
}
#[test]
#[ignore = "Actual Linux FUSE integration; run --test source_fuse -- --ignored"]
fn actual_linux_atomic_save_directories_truncate_fsync_exec_and_restart() {
    let server = MemorySource::new();
    let (dir, mount, _) = mounted(&server, false);
    let root = dir.path();
    eprintln!("FUSE step metadata");
    assert_eq!(fs::read_dir(root).unwrap().count(), 2);
    assert_eq!(fs::metadata(root.join("app.js")).unwrap().len(), 3);
    assert_eq!(server.reads(), 0);
    assert_eq!(fs::read(root.join("app.js")).unwrap(), b"old");
    eprintln!("FUSE step mkdir");
    fs::create_dir(root.join("src")).unwrap();
    fs::create_dir(root.join("src/nested")).unwrap();
    assert!(fs::remove_dir(root.join("src")).is_err());
    eprintln!("FUSE step create");
    let mut file = fs::File::create(root.join("src/nested/save.tmp")).unwrap();
    file.write_all(b"replacement").unwrap();
    file.sync_all().unwrap();
    drop(file);
    eprintln!("FUSE step rename");
    fs::rename(root.join("src/nested/save.tmp"), root.join("app.js")).unwrap();
    assert_eq!(fs::read(root.join("app.js")).unwrap(), b"replacement");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .open(root.join("app.js"))
        .unwrap();
    file.set_len(3).unwrap();
    file.seek(SeekFrom::Start(1)).unwrap();
    file.write_all(b"Z").unwrap();
    file.sync_all().unwrap();
    drop(file);
    assert_eq!(fs::read(root.join("app.js")).unwrap(), b"rZp");
    eprintln!("FUSE step exec_prepare");
    fs::write(root.join("run.sh"), b"#!/bin/sh\nprintf mounted-ok").unwrap();
    fs::set_permissions(root.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    eprintln!("FUSE step exec");
    let output = Command::new(root.join("run.sh")).output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"mounted-ok");
    assert!(fs::rename(root.join("src"), root.join("moved")).is_err());
    fs::remove_dir(root.join("src/nested")).unwrap();
    fs::remove_dir(root.join("src")).unwrap();
    fs::remove_file(root.join("run.sh")).unwrap();
    eprintln!("FUSE step close");
    mount.close().unwrap();
    let (dir, mount, _) = mounted(&server, false);
    assert_eq!(fs::read(dir.path().join("app.js")).unwrap(), b"rZp");
    assert!(!dir.path().join("src").exists());
    mount.close().unwrap();
}
#[test]
#[ignore = "Actual Linux FUSE integration; run --test source_fuse -- --ignored"]
fn actual_linux_mmap_api_coherence_and_cancellation() {
    let server = MemorySource::new();
    let (dir, mount, source) = mounted(&server, false);
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.path().join("app.js"))
        .unwrap();
    // Actual kernel mmap and msync, not a projected FS callback fixture.
    eprintln!("FUSE step mmap");
    let address = unsafe {
        libc::mmap(
            std::ptr::null_mut(),
            3,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_SHARED,
            file.as_raw_fd(),
            0,
        )
    };
    eprintln!("FUSE step map_read");
    assert_ne!(address, libc::MAP_FAILED);
    unsafe {
        assert_eq!(std::slice::from_raw_parts(address.cast::<u8>(), 3), b"old");
        eprintln!("FUSE step map_write");
        std::ptr::copy_nonoverlapping(b"map".as_ptr(), address.cast::<u8>(), 3);
        eprintln!("FUSE step msync");
        assert_eq!(libc::msync(address, 3, libc::MS_SYNC), 0);
        assert_eq!(libc::munmap(address, 3), 0);
    }
    eprintln!("FUSE step post_msync");
    file.sync_all().unwrap();
    drop(file); // Root closes/reaps every child handle before unmount/seal.
    assert_eq!(fs::read(dir.path().join("app.js")).unwrap(), b"map");
    server.external_write("app.js", b"api");
    eprintln!("FUSE step invalidate");
    mount.invalidate(&["app.js".into()]).unwrap();
    assert_eq!(fs::read(dir.path().join("app.js")).unwrap(), b"api");
    eprintln!("FUSE step cancel");
    source.cancel().unwrap();
    let mut file = fs::File::open(dir.path().join("app.js"));
    assert!(match file.as_mut() {
        Err(_) => true,
        Ok(file) => file.read(&mut [0u8; 3]).is_err(),
    });
    mount.close().unwrap();
}
#[test]
#[ignore = "Actual Linux FUSE integration; run --test source_fuse -- --ignored"]
fn actual_linux_readonly_root_cannot_write_or_mkdir_and_server_is_untouched() {
    let server = MemorySource::new();
    let (dir, mount, _) = mounted(&server, true);
    assert_eq!(fs::read(dir.path().join("app.js")).unwrap(), b"old");
    assert!(fs::write(dir.path().join("app.js"), b"unsafe").is_err());
    assert!(fs::create_dir(dir.path().join("src")).is_err());
    assert_eq!(server.mutations(), 0);
    mount.close().unwrap();
}
#[test]
#[ignore = "Actual Linux FUSE integration; run --test source_fuse -- --ignored"]
fn actual_linux_evaluation_cow_and_generated_scratch_preserve_tracked_source() {
    let server = MemorySource::new();
    server.seed("node_modules/tracked.js", b"tracked");
    let root = tempfile::tempdir().unwrap();
    let cow = source_workspace_eval::EvaluationSource::new(server.clone()).unwrap();
    let source = Arc::new(
        SourceWorkspace::new(
            cow,
            false,
            true,
            Arc::new(SourceCancellation::default()),
            1024,
        )
        .unwrap(),
    );
    let mount = SourceMount::mount(source, root.path()).unwrap();
    let generated = source_workspace_scratch::prefixes(
        ["app.js", "other.js", "node_modules/tracked.js"].into_iter(),
    );
    assert!(!generated.contains(&"node_modules/".to_string()));
    let scratch =
        source_workspace_scratch::GeneratedScratch::mount(root.path(), &generated).unwrap();
    fs::write(root.path().join("target/generated.js"), b"build-only").unwrap();
    assert_eq!(
        fs::read(root.path().join("target/generated.js")).unwrap(),
        b"build-only"
    );
    assert_eq!(server.mutations(), 0);
    fs::write(root.path().join("app.js"), b"check-local").unwrap();
    assert_eq!(
        fs::read(root.path().join("app.js")).unwrap(),
        b"check-local"
    );
    assert_eq!(
        fs::read(root.path().join("node_modules/tracked.js")).unwrap(),
        b"tracked"
    );
    assert_eq!(server.mutations(), 0);
    scratch.close().unwrap();
    mount.close().unwrap();
    use source_client::SourceBackend;
    assert_eq!(server.read("app.js", 1, 0, 3).unwrap().bytes, b"old");
}
#[test]
#[ignore = "Actual Linux FUSE integration; run --test source_fuse -- --ignored"]
fn actual_linux_large_requested_read_is_bounded_and_complete() {
    let server = MemorySource::new();
    let bytes = vec![b'Z'; 1024 * 1024];
    server.seed("large.bin", &bytes);
    let (dir, mount, _) = mounted(&server, false);
    assert_eq!(
        fs::metadata(dir.path().join("large.bin")).unwrap().len(),
        bytes.len() as u64
    );
    assert_eq!(server.reads(), 0);
    assert_eq!(fs::read(dir.path().join("large.bin")).unwrap(), bytes);
    mount.close().unwrap();
}
#[test]
#[ignore = "Actual Linux FUSE integration; run --test source_fuse -- --ignored"]
fn actual_linux_api_create_uncached_path_is_invalidated_before_ack() {
    let server = MemorySource::new();
    let (dir, mount, _) = mounted(&server, false);
    server.seed("newdir/new.js", b"new");
    mount.invalidate(&["newdir/new.js".into()]).unwrap();
    assert_eq!(fs::read(dir.path().join("newdir/new.js")).unwrap(), b"new");
    mount.close().unwrap();
}

#[path = "../src/secure_fs.rs"]
mod secure_fs;
#[path = "../src/site.rs"]
mod site;
fn err(error: impl std::fmt::Display) -> yoneda_core::Error {
    yoneda_core::Error::new("RUNTIME", error.to_string())
}
#[path = "support/source_static_export.rs"]
mod static_export;
