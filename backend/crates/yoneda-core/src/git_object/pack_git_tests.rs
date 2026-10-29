//! The pack reader against packs real `git pack-objects` writes: whole objects, OFS and
//! REF deltas (chains included), fed in chunks of every size; thin, truncated and corrupt
//! packs are refused.
use super::{ObjectId, ObjectKind, PackLimits, PackReader, Spill, hash_object};
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

/// Bytes that do not compress (a large file's pack entry is about its own size).
fn noise(n: usize) -> Vec<u8> {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    (0..n)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

/// `pack` read in `chunk`s with blobs over `spill` spilled: the reader, and each spilled
/// blob's content (taken after every feed, as the adapter does).
fn read_spilling(
    pack: &[u8],
    chunk: usize,
    spill: usize,
) -> crate::Result<(PackReader, Vec<Vec<u8>>, usize)> {
    let limits = PackLimits {
        spill_blob_bytes: spill,
        ..PackLimits::default()
    };
    let mut reader = PackReader::new(limits, 64 << 20);
    let (mut files, mut current, mut held) = (Vec::new(), Vec::new(), 0);
    let mut take = |reader: &mut PackReader| {
        for event in reader.take_spilled() {
            match event {
                Spill::Begin { size } => current = Vec::with_capacity(size),
                Spill::Data(bytes) => current.extend_from_slice(&bytes),
                Spill::End { id } => {
                    assert_eq!(hash_object(ObjectKind::Blob, &current), id);
                    files.push(std::mem::take(&mut current));
                }
            }
        }
    };
    for piece in pack.chunks(chunk) {
        reader.feed(piece)?;
        take(&mut reader);
        while reader.paused() {
            reader.feed(&[])?;
            take(&mut reader);
        }
        held = held.max(reader.received());
    }
    reader.finish()?;
    take(&mut reader);
    Ok((reader, files, held))
}

#[test]
fn spills_large_files_without_holding_them_and_keeps_delta_offsets() {
    let repo = history();
    let large = noise(300 * 1024);
    std::fs::write(repo.path().join("large.bin"), &large).unwrap();
    git(repo.path(), &["add", "-A"], None);
    git(repo.path(), &["commit", "-q", "-m", "large"], None);
    // Another round of deltified edits after the spilled entry: their offsets must hold.
    let mut text = std::fs::read_to_string(repo.path().join("big.txt")).unwrap();
    text.push_str("one more line\n");
    std::fs::write(repo.path().join("big.txt"), text).unwrap();
    git(repo.path(), &["commit", "-q", "-am", "after"], None);
    let expected = objects(repo.path());
    let pack = pack(repo.path(), &["--delta-base-offset"], "main\n");
    assert!(deltas(&pack) > 3);
    for chunk in [7, 4096, pack.len()] {
        let (mut reader, files, held) = read_spilling(&pack, chunk, 64 * 1024).unwrap();
        assert_eq!(files, vec![large.clone()], "chunks of {chunk}");
        let id = hash_object(ObjectKind::Blob, &large);
        assert!(reader.spilled(&id));
        assert!(
            held < pack.len() - large.len() + 64 * 1024,
            "held {held} of {}",
            pack.len()
        );
        assert_eq!(reader.objects().count(), expected.len());
        for (other, (_, want)) in &expected {
            if *other != id {
                assert_eq!(reader.content(other).unwrap().as_slice(), want.as_slice());
            }
        }
        assert_eq!(reader.content(&id).unwrap_err().code, "TOO_LARGE");
    }
    // A delta whose base was spilled cannot be resolved: refused, saying why.
    let refused = read_spilling(&pack, 4096, 1024).map(|_| ()).unwrap_err();
    assert_eq!(refused.code, "TOO_LARGE");
    assert!(refused.message.contains("Git LFS"), "{}", refused.message);
}
