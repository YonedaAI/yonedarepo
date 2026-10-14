use crate::{
    source_git::SourceGitObjects,
    source_git_rewrite::{TreeEdit, rewrite_tree},
    source_git_tree::TreeEntry,
};
use std::{
    collections::BTreeMap,
    io::Write,
    process::{Command, Stdio},
};
fn object(root: &std::path::Path, kind: &str, data: &[u8]) -> String {
    let mut child = Command::new("/usr/bin/git")
        .current_dir(root)
        .args(["hash-object", "--stdin", "-t", kind])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(data).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn native_tree(root: &std::path::Path, entries: &[TreeEntry]) -> String {
    let mut child = Command::new("/usr/bin/git")
        .current_dir(root)
        .args(["mktree", "--missing", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for entry in entries {
        let kind = if entry.mode == 0o040000 {
            "tree"
        } else {
            "blob"
        };
        write!(
            stdin,
            "{:o} {kind} {}\t{}\0",
            entry.mode, entry.oid, entry.name
        )
        .unwrap();
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn entry(name: &str, mode: u32, id: &str) -> TreeEntry {
    TreeEntry {
        name: name.into(),
        mode,
        oid: id.into(),
    }
}

#[test]
fn only_affected_ancestor_metadata_is_read_and_native_git_tree_matches() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = SourceGitObjects::create(&tmp.path().join("capture")).unwrap();
    let old = object(&tmp.path().join("capture"), "blob", b"unread");
    let empty = native_tree(&tmp.path().join("capture"), &[]);
    let child_entries = vec![entry("old", 0o100644, &old), entry("keep", 0o100644, &old)];
    let child = native_tree(&tmp.path().join("capture"), &child_entries);
    let root_entries = vec![
        entry("src", 0o040000, &child),
        entry("untouched", 0o040000, &empty),
        entry("README", 0o100644, &old),
    ];
    let base = native_tree(&tmp.path().join("capture"), &root_entries);
    let added = store.write("blob", b"\0\xff executable").unwrap();
    let edits = BTreeMap::from([
        ("src/old".into(), TreeEdit::Delete),
        (
            "src/new".into(),
            TreeEdit::Set {
                mode: 0o100755,
                oid: added.clone(),
            },
        ),
    ]);
    let mut reads = vec![];
    let mut load = |path: &str, oid: &str| {
        reads.push(path.to_owned());
        if path.is_empty() {
            assert_eq!(oid, base);
            Ok(root_entries.clone())
        } else if path == "src" {
            assert_eq!(oid, child);
            Ok(child_entries.clone())
        } else {
            panic!("Untouched subtree or blob read: {path}")
        }
    };
    let actual = rewrite_tree(&mut store, &base, &edits, &mut load).unwrap();
    let expected_child = native_tree(
        &tmp.path().join("capture"),
        &[
            entry("new", 0o100755, &added),
            entry("keep", 0o100644, &old),
        ],
    );
    let expected = native_tree(
        &tmp.path().join("capture"),
        &[
            entry("src", 0o040000, &expected_child),
            entry("untouched", 0o040000, &empty),
            entry("README", 0o100644, &old),
        ],
    );
    assert_eq!(actual, expected);
    assert_eq!(reads, vec!["", "src"]);
}

#[test]
fn metadata_hash_mismatch_and_implicit_directory_deletion_are_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let mut store = SourceGitObjects::create(&tmp.path().join("capture")).unwrap();
    let blob = store.write("blob", b"value").unwrap();
    let directory = native_tree(
        &tmp.path().join("capture"),
        &[entry("unread", 0o100644, &blob)],
    );
    let roots = vec![entry("dir", 0o040000, &directory)];
    let base = native_tree(&tmp.path().join("capture"), &roots);
    let edits = BTreeMap::from([(
        "dir".into(),
        TreeEdit::Set {
            mode: 0o100644,
            oid: blob,
        },
    )]);
    assert!(
        rewrite_tree(&mut store, &"f".repeat(40), &edits, &mut |_, _| Ok(
            roots.clone()
        ))
        .is_err(),
        "metadata must match frozen tree hash"
    );
    assert!(
        rewrite_tree(
            &mut store,
            &base,
            &edits,
            &mut |path, _| if path.is_empty() {
                Ok(roots.clone())
            } else {
                Ok(vec![])
            }
        )
        .is_err(),
        "cannot replace unread directory implicitly"
    );
}
