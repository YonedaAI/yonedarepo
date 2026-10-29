//! The builder against stock Git and a synthetic repository: the mirror lags two commits and
//! a tag behind, the platform has them; each pack holds exactly the objects a fetch with no
//! haves gets (`git rev-list --objects` in the source), and Git accepts it.
use std::path::Path;
use std::process::Command;
use yoneda_pack_builder::git::{Builder, Id, Shape};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Synthetic")
        .env("GIT_AUTHOR_EMAIL", "synthetic@example.com")
        .env("GIT_COMMITTER_NAME", "Synthetic")
        .env("GIT_COMMITTER_EMAIL", "synthetic@example.com")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("utf8")
        .trim()
        .to_owned()
}

/// Ids of the objects in `pack` (Git checks it on the way: index-pack fails on a bad pack).
fn objects_in(pack: &[u8], scratch: &Path) -> Vec<String> {
    let path = scratch.join("check.pack");
    std::fs::write(&path, pack).expect("pack written");
    let path = path.to_str().expect("path");
    git(scratch, &["index-pack", path]);
    let listed = git(
        scratch,
        &["verify-pack", "-v", &path.replace(".pack", ".idx")],
    );
    let mut ids: Vec<String> = listed
        .lines()
        .filter(|l| l.len() > 41 && l.as_bytes()[40] == b' ' && !l.starts_with("chain"))
        .map(|l| l[..40].to_owned())
        .collect();
    ids.sort();
    ids
}

fn expected(source: &Path, args: &[&str]) -> Vec<String> {
    let listed = git(source, &[&["rev-list", "--objects"], args].concat());
    let mut ids: Vec<String> = listed.lines().map(|l| l[..40].to_owned()).collect();
    ids.sort();
    ids
}

#[test]
fn builds_full_partial_and_shallow_packs_from_a_lagging_mirror_and_the_platform() {
    let scratch = std::env::temp_dir().join(format!("pack-builder-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    let (work, source, mirror) = (
        scratch.join("work"),
        scratch.join("source"),
        scratch.join("mirror.git"),
    );
    std::fs::create_dir_all(&work).expect("dirs");
    git(
        &scratch,
        &["init", "-q", "-b", "main", source.to_str().expect("path")],
    );
    for i in 0..5 {
        let text: String = (0..2000)
            .map(|n| format!("line {n} of version {i}\n"))
            .collect();
        std::fs::create_dir_all(source.join("src")).expect("src");
        std::fs::write(source.join("src/app.txt"), text).expect("file");
        std::fs::write(source.join(format!("n{i}.txt")), format!("file {i}\n")).expect("file");
        git(&source, &["add", "-A"]);
        git(&source, &["commit", "-q", "-m", &format!("step {i}")]);
        if i == 2 {
            git(
                &scratch,
                &[
                    "clone",
                    "-q",
                    "--bare",
                    source.to_str().expect("p"),
                    mirror.to_str().expect("p"),
                ],
            );
        }
    }
    git(&source, &["tag", "-a", "v1", "-m", "release"]);
    git(
        &source,
        &["config", "uploadpack.allowAnySHA1InWant", "true"],
    );
    let tip = git(&source, &["rev-parse", "main"]);
    let tag = git(&source, &["rev-parse", "v1"]);
    let blob = git(&source, &["rev-parse", "main:src/app.txt"]);

    let builder = Builder::new(
        &work.join("repo"),
        &format!("file://{}", mirror.display()),
        &format!("file://{}", source.display()),
    );
    let wants = [Id::parse(&tip).expect("id"), Id::parse(&tag).expect("id")];
    let fetched = builder.fetch(&wants).expect("fetch");
    assert!(fetched.mirror);
    assert_eq!(
        fetched.from_platform, 2,
        "the tip and the tag came from the platform"
    );
    assert_eq!(
        fetched.objects as usize,
        expected(&source, &[&tip, &tag]).len()
    );

    let cases: [(Shape, Vec<Id>, Vec<&str>); 4] = [
        (Shape::default(), wants.to_vec(), vec![&tip, &tag]),
        (
            Shape {
                omit_blobs: true,
                depth_one: false,
            },
            wants.to_vec(),
            vec!["--filter=blob:none", &tip, &tag],
        ),
        (
            Shape {
                omit_blobs: false,
                depth_one: true,
            },
            vec![wants[0].clone()],
            vec!["--no-walk", &tip],
        ),
        // A partial clone's checkout: blobs wanted by id come even with the filter.
        (
            Shape {
                omit_blobs: true,
                depth_one: false,
            },
            vec![Id::parse(&blob).expect("id")],
            vec!["--filter=blob:none", &blob],
        ),
    ];
    for (shape, wants, args) in cases {
        let mut pack = Vec::new();
        let packed = builder.pack(&wants, &shape, &mut pack).expect("pack");
        assert_eq!(packed.bytes as usize, pack.len());
        assert_eq!(
            objects_in(&pack, &scratch),
            expected(&source, &args),
            "{shape:?}"
        );
    }
    // An id the platform does not have fails the fetch, naming it.
    let unknown = Id::parse(&"0".repeat(40)).expect("id");
    assert!(builder.fetch(&[unknown]).is_err());
    let _ = std::fs::remove_dir_all(&scratch);
}
