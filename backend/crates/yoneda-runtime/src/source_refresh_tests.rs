//! Native Git metadata references for sparse refresh; no paid inference or hosted authority claim.
use crate::source_git_tree::TreeEntry;
use crate::{
    source_git_http_tests::{git, oid},
    source_refresh_plan::{Files, derive},
};
pub(crate) fn tree(root: &std::path::Path, commit: &str) -> Files {
    git(root, &["ls-tree", "-rz", commit], b"")
        .split(|b| *b == 0)
        .filter(|r| !r.is_empty())
        .map(|r| {
            let text = std::str::from_utf8(r).unwrap();
            let (meta, path) = text.split_once('\t').unwrap();
            let parts = meta.split(' ').collect::<Vec<_>>();
            (
                path.to_owned(),
                TreeEntry {
                    name: path.rsplit('/').next().unwrap().into(),
                    mode: u32::from_str_radix(parts[0], 8).unwrap(),
                    oid: parts[2].into(),
                },
            )
        })
        .collect()
}
#[test]
fn metadata_union_uses_real_git_oid_and_mode_with_no_unread_deletion() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-b", "main"], b"");
    for (name, body) in [
        ("untouched", "same\n"),
        ("text", "one\ntwo\nthree\n"),
        ("mode", "execute\n"),
    ] {
        std::fs::write(p.join(name), body).unwrap();
    }
    git(p, &["add", "."], b"");
    git(
        p,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@invalid",
            "commit",
            "-m",
            "base",
        ],
        b"",
    );
    let base = oid(git(p, &["rev-parse", "HEAD"], b""));
    std::fs::write(p.join("text"), "head\ntwo\nthree\n").unwrap();
    git(p, &["add", "."], b"");
    git(
        p,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@invalid",
            "commit",
            "-m",
            "head",
        ],
        b"",
    );
    let head = oid(git(p, &["rev-parse", "HEAD"], b""));
    git(p, &["checkout", "--detach", &base], b"");
    std::fs::write(p.join("text"), "one\ntwo\ncandidate\n").unwrap();
    git(p, &["add", "."], b"");
    git(p, &["update-index", "--chmod=+x", "mode"], b"");
    git(
        p,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@invalid",
            "commit",
            "-m",
            "candidate",
        ],
        b"",
    );
    let candidate = oid(git(p, &["rev-parse", "HEAD"], b""));
    let plan = derive(
        &tree(p, &base),
        &tree(p, &head),
        &tree(p, &candidate),
        &["mode".into(), "text".into()],
    )
    .unwrap();
    assert_eq!(plan.captured, ["mode".into(), "text".into()].into());
    assert_eq!(plan.intervening, ["text".into()].into());
    assert_eq!(plan.overlapping, ["text".into()].into());
    assert!(!plan.union.contains("untouched"));
    assert!(plan.structural.is_empty());
    assert!(
        derive(
            &tree(p, &base),
            &tree(p, &head),
            &tree(p, &candidate),
            &["text".into()]
        )
        .is_err()
    );
}
