//! Force an actual external REF_DELTA and prove receive-pack resolves it from the assigned base.
use crate::{
    source_git_http::SourceGitHttp,
    source_git_http_tests::{git, oid, server},
    source_refresh_upload::Upload,
};
#[tokio::test]
async fn actual_thin_delta_preload_resolves_only_against_retained_base() {
    let (s, old, _) = server().await;
    let target = s.root.path().join("fork.git");
    let mut state = 7u32;
    let before = (0..256000)
        .map(|_| {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            (state >> 24) as u8
        })
        .collect::<Vec<_>>();
    let base_blob = oid(git(&target, &["hash-object", "-w", "--stdin"], &before));
    let base_tree = oid(git(
        &target,
        &["mktree"],
        format!("100644 blob {base_blob}\tlarge.bin\n").as_bytes(),
    ));
    let base=oid(git(&target,&["hash-object","-w","-t","commit","--stdin"],format!("tree {base_tree}\nparent {old}\nauthor Test <test@invalid> 1 +0000\ncommitter Test <test@invalid> 1 +0000\n\nlarge base\n").as_bytes()));
    git(&target, &["update-ref", "refs/heads/main", &base], b"");
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
    let mut after = before.clone();
    after[120000..120010].copy_from_slice(b"tenchanged");
    let blob = oid(git(&source, &["hash-object", "-w", "--stdin"], &after));
    let tree = oid(git(
        &source,
        &["mktree"],
        format!("100644 blob {blob}\tlarge.bin\n").as_bytes(),
    ));
    let candidate=oid(git(&source,&["hash-object","-w","-t","commit","--stdin"],format!("tree {tree}\nparent {base}\nauthor Test <test@invalid> 2 +0000\ncommitter Test <test@invalid> 2 +0000\n\ncandidate\n").as_bytes()));
    git(&source, &["update-ref", "refs/heads/main", &candidate], b"");
    let pack = s.root.path().join("thin.pack");
    Upload::new(&s.url.replace("fork.git", "candidate.git"), None)
        .unwrap()
        .difference(&candidate, &base, &pack, 1024 * 1024)
        .await
        .unwrap();
    let bytes = std::fs::read(&pack).unwrap();
    assert_eq!(u32::from_be_bytes(bytes[8..12].try_into().unwrap()), 3);
    assert!(
        bytes.len() < 4096,
        "unchanged 256000-byte base body never retransferred"
    );
    let inspect = s.root.path().join("inspect.git");
    git(
        s.root.path(),
        &[
            "clone",
            "--bare",
            target.to_str().unwrap(),
            inspect.to_str().unwrap(),
        ],
        b"",
    );
    let output = oid(git(
        &inspect,
        &["index-pack", "--stdin", "--fix-thin"],
        &bytes,
    ));
    let hash = output.split_whitespace().last().unwrap();
    let fixed = std::fs::read(inspect.join(format!("objects/pack/pack-{hash}.pack"))).unwrap();
    assert_eq!(
        u32::from_be_bytes(fixed[8..12].try_into().unwrap()),
        4,
        "fix-thin appended external base: this fixture genuinely uses an unresolved REF_DELTA"
    );
    let receiver = SourceGitHttp::new(&s.url, None).unwrap();
    let reference = format!(
        "refs/yoneda/source-input/{}",
        yoneda_agents_core::digest(b"thin-job")
    );
    receiver
        .push_input_ref(&reference, &candidate, &pack, 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(git(&target, &["cat-file", "blob", &blob], b""), after);
    assert_eq!(oid(git(&target, &["rev-parse", "main"], b"")), base);
}
