use crate::source_git::SourceGitObjects;
use crate::source_git_tree::{TreeEntry, encode_tree};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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
fn native(root: &Path, args: &[&str], input: &[u8]) -> Vec<u8> {
    let mut child = Command::new("/usr/bin/git")
        .current_dir(root)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

#[test]
fn explicit_pack_contains_new_objects_only_and_deterministic_ordered_parents() {
    let fixture = Fixture::new();
    let mut store = SourceGitObjects::create(&fixture.0.join("objects")).unwrap();
    let blob = store.write("blob", b"changed binary\0\xff").unwrap();
    let untouched = "2".repeat(40);
    let tree = store
        .write(
            "tree",
            &encode_tree(&[
                TreeEntry {
                    name: "new.bin".into(),
                    mode: 0o100755,
                    oid: blob.clone(),
                },
                TreeEntry {
                    name: "untouched".into(),
                    mode: 0o040000,
                    oid: untouched.clone(),
                },
            ])
            .unwrap(),
        )
        .unwrap();
    let parents = vec!["3".repeat(40), "4".repeat(40)];
    let commit = store.commit(&tree, &parents, "sealed source").unwrap();
    assert_eq!(
        commit,
        store.commit(&tree, &parents, "sealed source").unwrap()
    );
    let raw = native(
        &fixture.0.join("objects"),
        &["cat-file", "commit", &commit],
        b"",
    );
    let text = String::from_utf8(raw).unwrap();
    assert!(text.starts_with(&format!(
        "tree {tree}\nparent {}\nparent {}\n",
        parents[0], parents[1]
    )));
    assert_ne!(
        commit,
        store
            .commit(
                &tree,
                &[parents[1].clone(), parents[0].clone()],
                "sealed source"
            )
            .unwrap()
    );
    let pack = store.pack(1_048_576).unwrap();
    let data = std::fs::read(&pack).unwrap();
    assert_eq!(&data[..8], b"PACK\0\0\0\x02");
    assert_eq!(u32::from_be_bytes(data[8..12].try_into().unwrap()), 4);
    assert!(
        !fixture
            .0
            .join("objects/objects")
            .join(&untouched[..2])
            .join(&untouched[2..])
            .exists(),
        "untouched subtree must not be fetched or packed"
    );
    assert!(
        store.pack(1).is_err(),
        "pack output must honor its capability size bound"
    );
}

#[test]
fn fresh_store_rejects_existing_agent_repository_and_invalid_parent() {
    let fixture = Fixture::new();
    assert!(
        SourceGitObjects::create(&fixture.0).is_err(),
        "cannot reuse an agent-controlled directory"
    );
    let mut store = SourceGitObjects::create(&fixture.0.join("trusted")).unwrap();
    let tree = store.write("tree", b"").unwrap();
    for parents in [
        vec![],
        vec!["a".repeat(64)],
        vec!["a".repeat(40); 3],
        vec!["a".repeat(40); 2],
    ] {
        assert!(store.commit(&tree, &parents, "sealed").is_err());
    }
    assert!(store.write("tag", b"arbitrary agent object").is_err());
}

#[test]
fn native_receive_pack_requires_base_closure_and_retains_wide_untouched_tree() {
    let fixture = Fixture::new();
    let destination = fixture.0.join("destination");
    std::fs::create_dir(&destination).unwrap();
    native(
        &destination,
        &["init", "--bare", "--object-format=sha1"],
        b"",
    );
    let oid = |data: Vec<u8>| String::from_utf8(data).unwrap().trim().to_owned();
    let unchanged = oid(native(
        &destination,
        &["hash-object", "-w", "--stdin"],
        b"base bytes",
    ));
    let mut entries = (0..1000)
        .map(|n| TreeEntry {
            name: format!("untouched-{n:04}"),
            mode: 0o100644,
            oid: unchanged.clone(),
        })
        .collect::<Vec<_>>();
    let base_tree = oid(native(
        &destination,
        &["hash-object", "-w", "--stdin", "-t", "tree"],
        &encode_tree(&entries).unwrap(),
    ));
    let base_raw = format!(
        "tree {base_tree}\nauthor Test <test@invalid> 0 +0000\ncommitter Test <test@invalid> 0 +0000\n\nbase\n"
    );
    let base = oid(native(
        &destination,
        &["hash-object", "-w", "--stdin", "-t", "commit"],
        base_raw.as_bytes(),
    ));
    native(&destination, &["update-ref", "refs/heads/main", &base], b"");
    let mut store = SourceGitObjects::create(&fixture.0.join("capture")).unwrap();
    let added = store.write("blob", &[0, 255, 128]).unwrap();
    entries.push(TreeEntry {
        name: "new-executable".into(),
        mode: 0o100755,
        oid: added,
    });
    let tree = store
        .write("tree", &encode_tree(&entries).unwrap())
        .unwrap();
    let commit = store
        .commit(&tree, std::slice::from_ref(&base), "sealed source")
        .unwrap();
    let pack = std::fs::read(store.pack(1024 * 1024).unwrap()).unwrap();
    assert_eq!(
        u32::from_be_bytes(pack[8..12].try_into().unwrap()),
        3,
        "no base blobs, base tree or history in explicit pack"
    );
    let command = format!("{base} {commit} refs/heads/main\0report-status\n");
    let mut request = format!("{:04x}{command}0000", command.len() + 4).into_bytes();
    request.extend(pack);
    let report = native(
        &destination,
        &["receive-pack", "--stateless-rpc", "."],
        &request,
    );
    assert!(String::from_utf8_lossy(&report).contains("unpack ok"));
    assert_eq!(
        oid(native(
            &destination,
            &["rev-parse", "refs/heads/main^{tree}"],
            b""
        )),
        tree
    );
    assert_eq!(
        native(&destination, &["cat-file", "blob", &unchanged], b""),
        b"base bytes"
    );
    // The receive result can be lost: the stable deterministic ID is independently readable.
    assert_eq!(
        oid(native(&destination, &["rev-parse", "refs/heads/main"], b"")),
        commit
    );
    assert_eq!(
        commit,
        store
            .commit(&tree, std::slice::from_ref(&base), "sealed source")
            .unwrap()
    );
    let mut absent = SourceGitObjects::create(&fixture.0.join("missing-closure")).unwrap();
    let invalid_tree = absent
        .write(
            "tree",
            &encode_tree(&[TreeEntry {
                name: "missing".into(),
                mode: 0o100644,
                oid: "f".repeat(40),
            }])
            .unwrap(),
        )
        .unwrap();
    let invalid_commit = absent
        .commit(&invalid_tree, std::slice::from_ref(&commit), "invalid")
        .unwrap();
    let command = format!("{commit} {invalid_commit} refs/heads/main\0report-status\n");
    let mut request = format!("{:04x}{command}0000", command.len() + 4).into_bytes();
    request.extend(std::fs::read(absent.pack(1024 * 1024).unwrap()).unwrap());
    let report = native(
        &destination,
        &["receive-pack", "--stateless-rpc", "."],
        &request,
    );
    assert!(
        String::from_utf8_lossy(&report).contains("ng refs/heads/main"),
        "real Git must refuse missing object closure"
    );
    assert_eq!(
        oid(native(&destination, &["rev-parse", "refs/heads/main"], b"")),
        commit
    );
}

#[test]
fn changed_stream_requires_exact_sealed_size() {
    let fixture = Fixture::new();
    let mut store = SourceGitObjects::create(&fixture.0.join("capture")).unwrap();
    assert!(store.write_reader("blob", 2, b"abc".as_slice()).is_err());
    assert!(store.write_reader("blob", 4, b"abc".as_slice()).is_err());
    let good = store.write_reader("blob", 3, b"abc".as_slice()).unwrap();
    assert_eq!(good, store.write("blob", b"abc").unwrap());
    assert_eq!(
        u32::from_be_bytes(
            std::fs::read(store.pack(1024).unwrap()).unwrap()[8..12]
                .try_into()
                .unwrap()
        ),
        1,
        "unsealed streams must not enter the explicit pack"
    );
}
