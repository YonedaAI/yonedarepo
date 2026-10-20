//! Proves server-built objects and packs from `yoneda_core::git_object` are accepted by
//! real Git: `index-pack` ingests the pack and `fsck` finds every object well formed.
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use yoneda_core::git_object::{
    Commit, FileMode, ObjectKind, PathChange, Signature, TreeEntry, TreeSource, hash_object,
    rewrite_tree, write_pack,
};

struct NoTrees;
impl TreeSource for NoTrees {
    fn tree(
        &self,
        _: &yoneda_core::git_object::ObjectId,
    ) -> yoneda_agents_core::Result<Vec<TreeEntry>> {
        Err(yoneda_agents_core::Error::new(
            "TEST",
            "empty base has no trees",
        ))
    }
}

fn git(dir: &Path, args: &[&str], input: &[u8]) -> Vec<u8> {
    let mut child = Command::new("/usr/bin/git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap()
}

#[test]
fn git_accepts_server_built_pack_and_commit() {
    let dir = tempfile::tempdir().unwrap();
    git(
        dir.path(),
        &["init", "--bare", "--object-format=sha1", "-q"],
        b"",
    );
    let readme = b"# demo\n".to_vec();
    let binary = vec![0u8, 159, 146, 150, 255];
    let script = b"#!/bin/sh\necho ok\n".to_vec();
    let blobs = [&readme, &binary, &script].map(|b| hash_object(ObjectKind::Blob, b));
    let changes = [
        ("README.md", FileMode::Blob, blobs[0]),
        ("assets/logo.bin", FileMode::Blob, blobs[1]),
        ("bin/run", FileMode::Executable, blobs[2]),
    ]
    .map(|(path, mode, id)| PathChange {
        path: path.into(),
        target: Some((mode, id)),
    });
    let rewrite = rewrite_tree(None, &changes, &NoTrees).unwrap();
    let who = Signature {
        name: "Agent".into(),
        email: "agent@yoneda.invalid".into(),
        seconds: 1_700_000_000,
        offset: "+0000".into(),
    };
    let commit = Commit::new(rewrite.root, &[], &who, &who, "Seed\n\nYoneda-Attempt: a1").unwrap();
    let commit_bytes = commit.encode();
    let mut objects: Vec<(ObjectKind, &[u8])> = vec![(ObjectKind::Commit, &commit_bytes)];
    objects.extend(
        rewrite
            .trees
            .iter()
            .map(|(_, bytes)| (ObjectKind::Tree, bytes.as_slice())),
    );
    objects.extend([&readme, &binary, &script].map(|b| (ObjectKind::Blob, b.as_slice())));
    let pack = write_pack(&objects).unwrap();

    git(dir.path(), &["index-pack", "--stdin", "--strict"], &pack);
    git(
        dir.path(),
        &["update-ref", "refs/heads/main", &commit.id().hex()],
        b"",
    );
    git(dir.path(), &["fsck", "--strict", "--no-dangling"], b"");
    assert_eq!(
        text(git(dir.path(), &["rev-parse", "main^{tree}"], b"")).trim(),
        rewrite.root.hex()
    );
    assert_eq!(
        git(dir.path(), &["cat-file", "-p", "main:assets/logo.bin"], b""),
        binary
    );
    assert!(text(git(dir.path(), &["ls-tree", "-r", "main"], b"")).contains("100755 blob"));
}
