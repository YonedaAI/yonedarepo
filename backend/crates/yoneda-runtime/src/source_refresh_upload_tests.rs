//! Real local Git smart HTTP negotiated difference pack and private-ref lost-ACK recovery.
use crate::{
    source_git_http::SourceGitHttp,
    source_git_http_tests::{Server, git, oid, server},
    source_git_tree::{TreeEntry, encode_tree},
    source_refresh_upload::Upload,
};
use std::sync::atomic::Ordering;
fn candidate(s: &Server, base: &str) -> (String, Vec<u8>, String) {
    let target = s.root.path().join("fork.git");
    let source = s.root.path().join("candidate.git");
    git(
        s.root.path(),
        &[
            "clone",
            "--bare",
            target.to_str().unwrap(),
            source.to_str().unwrap(),
        ],
        b"",
    );
    let unchanged = oid(git(&source, &["rev-parse", &format!("{base}:base")], b""));
    let changed = oid(git(
        &source,
        &["hash-object", "-w", "--stdin"],
        b"new candidate body\0\xff",
    ));
    let tree = oid(git(
        &source,
        &["hash-object", "-w", "-t", "tree", "--stdin"],
        &encode_tree(&[
            TreeEntry {
                name: "base".into(),
                mode: 0o100644,
                oid: unchanged.clone(),
            },
            TreeEntry {
                name: "changed".into(),
                mode: 0o100644,
                oid: changed,
            },
        ])
        .unwrap(),
    ));
    let raw=format!("tree {tree}\nparent {base}\nauthor Test <test@invalid> 123 -0430\ncommitter Test <test@invalid> 123 -0430\ngpgsig fixture-only-not-verified\n continuation\n\nraw candidate preserved\n\n").into_bytes();
    let commit = oid(git(
        &source,
        &["hash-object", "-w", "-t", "commit", "--stdin"],
        &raw,
    ));
    git(&source, &["update-ref", "refs/heads/main", &commit], b"");
    (commit, raw, unchanged)
}
#[tokio::test]
async fn negotiated_pack_excludes_base_objects_preserves_raw_commit_and_recovers_preload_ack() {
    let (s, base, _) = server().await;
    let (commit, raw, unchanged) = candidate(&s, &base);
    let source = s.url.replace("fork.git", "candidate.git");
    let upload = Upload::new(&source, None).unwrap();
    let pack = s.root.path().join("negotiated.pack");
    upload
        .difference(&commit, &base, &pack, 1024 * 1024)
        .await
        .unwrap();
    let bytes = std::fs::read(&pack).unwrap();
    assert_eq!(&bytes[..4], b"PACK");
    assert_eq!(
        u32::from_be_bytes(bytes[8..12].try_into().unwrap()),
        3,
        "only candidate commit/tree/new blob transferred, unread base bodies excluded"
    );
    // Test-only index inspection; production transfers the opaque pack directly without indexing.
    let inspect = s.root.path().join("inspect.git");
    git(
        s.root.path(),
        &[
            "clone",
            "--bare",
            s.root.path().join("fork.git").to_str().unwrap(),
            inspect.to_str().unwrap(),
        ],
        b"",
    );
    let name = oid(git(
        &inspect,
        &["index-pack", "--stdin", "--fix-thin"],
        &bytes,
    ));
    let hash = name.split_whitespace().last().unwrap();
    let index = inspect.join(format!("objects/pack/pack-{hash}.idx"));
    let listed = String::from_utf8(git(
        &inspect,
        &["verify-pack", "-v", index.to_str().unwrap()],
        b"",
    ))
    .unwrap();
    assert!(!listed.lines().any(|line| line.starts_with(&unchanged)));
    assert!(!listed.lines().any(|line| line.starts_with(&base)));
    let reference = format!(
        "refs/yoneda/source-input/{}",
        yoneda_agents_core::digest(b"capture-job")
    );
    let receiver = SourceGitHttp::new(&s.url, None).unwrap();
    s.lose_ack.store(true, Ordering::SeqCst);
    let pushed = receiver
        .push_input_ref(&reference, &commit, &pack, 1024 * 1024)
        .await
        .unwrap();
    assert!(pushed.recovered_ack && pushed.uploaded);
    let retry = receiver
        .push_input_ref(&reference, &commit, &pack, 1024 * 1024)
        .await
        .unwrap();
    assert!(retry.recovered_ack && !retry.uploaded);
    assert_eq!(
        git(
            &s.root.path().join("fork.git"),
            &["cat-file", "commit", &commit],
            b""
        ),
        raw
    );
    assert_eq!(
        oid(git(
            &s.root.path().join("fork.git"),
            &["rev-parse", "main"],
            b""
        )),
        base
    );
    assert!(
        receiver
            .push_input_ref("refs/heads/main", &commit, &pack, 1024 * 1024)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn no_common_base_ack_or_oversized_difference_never_reaches_receiver() {
    let (s, base, _) = server().await;
    let (commit, _, _) = candidate(&s, &base);
    let upload = Upload::new(&s.url.replace("fork.git", "candidate.git"), None).unwrap();
    let missing = s.root.path().join("missing.pack");
    assert!(
        upload
            .difference(&commit, &"f".repeat(40), &missing, 1024 * 1024)
            .await
            .is_err()
    );
    assert!(!missing.exists());
    assert!(
        upload
            .difference(&commit, &base, &s.root.path().join("over.pack"), 32)
            .await
            .is_err()
    );
    assert!(!s.root.path().join("received.request").exists());
}
