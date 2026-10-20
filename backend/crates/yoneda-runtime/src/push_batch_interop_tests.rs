//! Differential test: a combined platform push is accepted by real `git receive-pack`
//! (the protocol Artifacts speaks), creating every hidden ref, and its report splits into
//! per-ref reports the platform verifies.
use std::io::Write;
use std::process::{Command, Stdio};
use yoneda_core::git_object::{
    ObjectKind, combine_receive_pack_requests, hash_object, receive_pack_request,
    split_receive_pack_report, verify_receive_pack_report, write_pack,
};

fn git(dir: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::new("/usr/bin/git")
        .args(args)
        .current_dir(dir)
        .env_clear()
        .env("HOME", "/nonexistent")
        .output()
        .unwrap()
}

#[test]
fn git_receive_pack_accepts_a_combined_push() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        git(dir.path(), &["init", "--bare", "-q", "."])
            .status
            .success()
    );
    let bodies: Vec<_> = (0..3)
        .map(|i| {
            let blob = format!("blob {i}\n");
            let id = hash_object(ObjectKind::Blob, blob.as_bytes());
            let pack = write_pack(&[(ObjectKind::Blob, blob.as_bytes())]).unwrap();
            receive_pack_request(&format!("refs/yoneda/c/{i}"), None, id, &pack).unwrap()
        })
        .collect();
    let slices: Vec<&[u8]> = bodies.iter().map(Vec::as_slice).collect();
    let (body, refs) = combine_receive_pack_requests(&slices).unwrap();
    let mut child = Command::new("/usr/bin/git")
        .args(["receive-pack", "--stateless-rpc", "."])
        .current_dir(dir.path())
        .env_clear()
        .env("HOME", "/nonexistent")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(&body).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    for refname in &refs {
        let report = split_receive_pack_report(&output.stdout, refname).unwrap();
        verify_receive_pack_report(&report, refname).unwrap();
    }
    let listed =
        String::from_utf8(git(dir.path(), &["for-each-ref", "--format=%(refname)"]).stdout)
            .unwrap();
    assert_eq!(listed.lines().collect::<Vec<_>>(), refs);
    assert!(git(dir.path(), &["fsck", "--strict"]).status.success());
}
