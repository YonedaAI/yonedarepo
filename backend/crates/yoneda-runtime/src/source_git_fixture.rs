//! Real local Git plumbing for capture fixtures: a bare repository holding one base commit.
use crate::source_git_tree::{TreeEntry, encode_tree};
use std::{
    io::Write,
    process::{Command, Stdio},
};

pub(crate) struct Server {
    pub root: tempfile::TempDir,
}

pub(crate) fn git(root: &std::path::Path, args: &[&str], bytes: &[u8]) -> Vec<u8> {
    let mut c = Command::new("/usr/bin/git")
        .current_dir(root)
        .args(args)
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@invalid")
        .env("GIT_AUTHOR_DATE", "2026-10-07T00:00:00Z")
        .env("GIT_COMMITTER_DATE", "2026-10-07T00:00:00Z")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    c.stdin.take().unwrap().write_all(bytes).unwrap();
    let o = c.wait_with_output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    o.stdout
}
pub(crate) fn oid(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap().trim().into()
}
pub(crate) async fn server() -> (Server, String, String) {
    let root = tempfile::tempdir().unwrap();
    let dest = root.path().join("fork.git");
    std::fs::create_dir(&dest).unwrap();
    git(&dest, &["init", "--bare", "--object-format=sha1"], b"");
    let blob = oid(git(&dest, &["hash-object", "-w", "--stdin"], b"untouched"));
    let tree = oid(git(
        &dest,
        &["hash-object", "-w", "--stdin", "-t", "tree"],
        &encode_tree(&[TreeEntry {
            name: "base".into(),
            mode: 0o100644,
            oid: blob,
        }])
        .unwrap(),
    ));
    let commit=oid(git(&dest,&["hash-object","-w","--stdin","-t","commit"],format!("tree {tree}\nauthor Test <test@invalid> 0 +0000\ncommitter Test <test@invalid> 0 +0000\n\nbase\n").as_bytes()));
    git(&dest, &["update-ref", "refs/heads/main", &commit], b"");
    (Server { root }, commit, tree)
}
