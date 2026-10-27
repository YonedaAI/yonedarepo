//! The pack reader against packs real `git pack-objects` writes: whole objects, OFS and
//! REF deltas (chains included), fed in chunks of every size; thin, truncated and corrupt
//! packs are refused.
use super::{ObjectId, ObjectKind, PackLimits, PackReader, hash_object};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

fn git(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Vec<u8> {
    let mut child = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .env("GIT_AUTHOR_NAME", "T")
        .env("GIT_AUTHOR_EMAIL", "t@example.com")
        .env("GIT_COMMITTER_NAME", "T")
        .env("GIT_COMMITTER_EMAIL", "t@example.com")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(input.unwrap_or_default()).unwrap();
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "git {args:?} failed");
    out.stdout
}

/// A repository whose history makes Git deltify: one large file edited repeatedly.
fn history() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    git(path, &["init", "-q", "-b", "main", "."], None);
    let mut lines: Vec<String> = (0..400)
        .map(|i| format!("line {i} of a long file\n"))
        .collect();
    for round in 0..8 {
        lines[round * 37] = format!("edited in round {round}\n");
        std::fs::write(path.join("big.txt"), lines.concat()).unwrap();
        std::fs::create_dir_all(path.join("src")).unwrap();
        std::fs::write(
            path.join(format!("src/f{round}.rs")),
            format!("fn f{round}() {{}}\n"),
        )
        .unwrap();
        git(path, &["add", "-A"], None);
        git(
            path,
            &["commit", "-q", "-m", &format!("round {round}")],
            None,
        );
    }
    dir
}

/// Every object id in the repository, with its kind and content.
fn objects(dir: &Path) -> BTreeMap<ObjectId, (ObjectKind, Vec<u8>)> {
    let listed = String::from_utf8(git(dir, &["rev-list", "--objects", "--all"], None)).unwrap();
    listed
        .lines()
        .map(|line| {
            let id = line.split(' ').next().unwrap();
            let kind = String::from_utf8(git(dir, &["cat-file", "-t", id], None)).unwrap();
            let kind = match kind.trim() {
                "commit" => ObjectKind::Commit,
                "tree" => ObjectKind::Tree,
                _ => ObjectKind::Blob,
            };
            let data = git(dir, &["cat-file", kind_name(kind), id], None);
            assert_eq!(hash_object(kind, &data).hex(), id);
            (ObjectId::parse(id).unwrap(), (kind, data))
        })
        .collect()
}

fn kind_name(kind: ObjectKind) -> &'static str {
    kind.name()
}

fn read(pack: &[u8], chunk: usize) -> Result<PackReader, crate::Error> {
    let mut reader = PackReader::new(PackLimits::default(), 64 << 20);
    for piece in pack.chunks(chunk) {
        reader.feed(piece)?;
    }
    reader.finish()?;
    Ok(reader)
}

fn pack(dir: &Path, flags: &[&str], revs: &str) -> Vec<u8> {
    let mut args = vec!["pack-objects", "--stdout", "--revs", "-q"];
    args.extend(flags);
    git(dir, &args, Some(revs.as_bytes()))
}

fn deltas(pack: &[u8]) -> usize {
    // Count delta entries via git itself: verify-pack lists their depth.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("p.pack"), pack).unwrap();
    git(dir.path(), &["init", "-q", "."], None);
    git(dir.path(), &["index-pack", "p.pack"], None);
    let listed = String::from_utf8(git(dir.path(), &["verify-pack", "-v", "p.idx"], None)).unwrap();
    listed
        .lines()
        .filter(|l| l.split_whitespace().count() == 7)
        .count()
}

#[test]
fn reads_real_packs_with_both_delta_kinds_in_any_chunking() {
    let repo = history();
    let expected = objects(repo.path());
    for flags in [&["--delta-base-offset"][..], &[][..]] {
        let pack = pack(repo.path(), flags, "main\n");
        assert!(deltas(&pack) > 3, "the pack must hold deltas ({flags:?})");
        for chunk in [1, 7, 4096, pack.len()] {
            let mut reader = read(&pack, chunk).unwrap();
            let got: Vec<_> = reader.objects().collect();
            assert_eq!(got.len(), expected.len());
            for (id, kind) in got {
                let (want_kind, want) = &expected[&id];
                assert_eq!(kind, *want_kind);
                assert_eq!(reader.content(&id).unwrap().as_slice(), want.as_slice());
                if kind != ObjectKind::Blob {
                    assert_eq!(reader.kept(&id).unwrap(), want.as_slice());
                }
            }
        }
    }
}

#[test]
fn refuses_thin_truncated_and_corrupt_packs() {
    let repo = history();
    let thin = pack(
        repo.path(),
        &["--thin", "--delta-base-offset"],
        "main\n^main~1\n",
    );
    assert!(deltas_against_missing(&thin));
    assert!(read(&thin, 4096).is_err());
    let full = pack(repo.path(), &["--delta-base-offset"], "main\n");
    assert!(read(&full[..full.len() - 1], 4096).is_err());
    let mut corrupt = full.clone();
    let middle = corrupt.len() / 2;
    corrupt[middle] ^= 0x40;
    assert!(read(&corrupt, 4096).is_err());
    let mut extra = full.clone();
    extra.push(0);
    assert!(read(&extra, 4096).is_err());
    let mut small = PackReader::new(PackLimits::default(), full.len() - 1);
    assert_eq!(small.feed(&full).unwrap_err().code, "TOO_LARGE");
}

/// Whether `pack` (thin) refers to a base outside itself: `index-pack --fix-thin` needs
/// the repository to complete it.
fn deltas_against_missing(pack: &[u8]) -> bool {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("p.pack"), pack).unwrap();
    git(dir.path(), &["init", "-q", "."], None);
    !Command::new("git")
        .args(["index-pack", "p.pack"])
        .current_dir(dir.path())
        .output()
        .unwrap()
        .status
        .success()
}
