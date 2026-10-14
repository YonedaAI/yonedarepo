//! Standalone native Git comparisons; no provider, transport mocks or paid inference.
use crate::source_git_tree::{TreeEntry, encode_tree};
use std::io::Write;
use std::process::{Command, Stdio};

fn entry(name: &str, mode: u32, oid: &str) -> TreeEntry {
    TreeEntry {
        name: name.into(),
        mode,
        oid: oid.into(),
    }
}

fn native_hash(kind: &str, data: &[u8]) -> String {
    let mut child = Command::new("/usr/bin/git")
        .args(["hash-object", "--stdin", "-t", kind])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(data).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn tree_preserves_untouched_ids_and_git_directory_order() {
    let blob = native_hash("blob", b"untouched binary\0\xff");
    let subtree = native_hash("tree", b"");
    let actual = encode_tree(&[
        entry("a", 0o040000, &subtree),
        entry("a.txt", 0o100755, &blob),
        entry("a-", 0o100644, &blob),
    ])
    .unwrap();
    let raw = |mode: &str, name: &str, oid: &str| {
        let mut value = format!("{mode} {name}\0").into_bytes();
        value.extend(
            (0..40)
                .step_by(2)
                .map(|i| u8::from_str_radix(&oid[i..i + 2], 16).unwrap()),
        );
        value
    };
    let expected = [
        raw("100644", "a-", &blob),
        raw("100755", "a.txt", &blob),
        raw("40000", "a", &subtree),
    ]
    .concat();
    assert_eq!(
        actual, expected,
        "tree must retain untouched binary IDs and Git bytewise slash ordering"
    );
    assert_eq!(native_hash("tree", &actual), native_hash("tree", &expected));
}

#[test]
fn malformed_names_modes_ids_and_duplicate_entries_are_rejected() {
    let oid = "1".repeat(40);
    for name in ["", ".", "..", "dir/file", "bad\0name"] {
        assert!(
            encode_tree(&[entry(name, 0o100644, &oid)]).is_err(),
            "unsafe component {name:?}"
        );
    }
    for mode in [0o120000, 0o160000, 0o100600] {
        assert!(encode_tree(&[entry("x", mode, &oid)]).is_err());
    }
    for wrong in ["1".repeat(64), "A".repeat(40), "g".repeat(40)] {
        assert!(encode_tree(&[entry("x", 0o100644, &wrong)]).is_err());
    }
    assert!(encode_tree(&[entry("x", 0o100644, &oid), entry("x", 0o040000, &oid)]).is_err());
}

#[test]
fn wide_directory_is_bounded_before_encoding() {
    let entries = (0..100_001)
        .map(|n| entry(&format!("{n:06}"), 0o100644, &"1".repeat(40)))
        .collect::<Vec<_>>();
    assert!(
        encode_tree(&entries).is_err(),
        "wide metadata must have a hard entry bound"
    );
}
