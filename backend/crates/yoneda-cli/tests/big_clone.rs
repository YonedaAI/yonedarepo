//! Big-repository clones with stock `git` over the local platform's smart HTTP (protocol
//! version 2): a partial clone (`--filter=blob:none`) receives commits and trees only and
//! fetches the files a checkout needs lazily, by id; a shallow clone (`--depth 1`) deepens
//! (`git fetch --deepen 5`) and unshallows; every result passes `git fsck`, and a
//! version 0 clone still works. Run with `cargo test -p yoneda-cli --test big_clone --
//! --include-ignored --nocapture`; it needs the workspace's node modules (wrangler) and
//! the Rust Wasm worker build.
#[allow(dead_code)] // shared with the remote helper tests
mod support;

use std::path::Path;
use support::{Client, Platform, TestResult};

const FILES: usize = 200;
const COMMITS: usize = 10;

fn check(condition: bool, what: &str) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(what.to_owned())
    }
}

/// A client whose Git finds `token` in its credential store.
fn client(platform: &Platform, name: &str, token: &str) -> TestResult<Client> {
    let home = platform.scratch.path().join(format!("big-{name}"));
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    let host = platform.origin.trim_start_matches("http://");
    std::fs::write(
        home.join(".git-credentials"),
        format!("http://git:{token}@{host}\n"),
    )
    .map_err(|e| e.to_string())?;
    let client = Client {
        home: home.clone(),
        token: String::new(),
    };
    client.git(&home, &["config", "--global", "credential.helper", "store"])?;
    client.git(&home, &["config", "--global", "init.defaultBranch", "main"])?;
    Ok(client)
}

/// `n` bytes of hex text from `seed` (it compresses about as well as source would not).
fn text(seed: u64, n: usize) -> String {
    let mut state = seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
    (0..n)
        .map(|i| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            if i % 64 == 63 {
                '\n'
            } else {
                char::from(b"0123456789abcdef"[(state % 16) as usize])
            }
        })
        .collect()
}

/// Bytes of the packs a clone in `dir` holds.
fn pack_bytes(dir: &Path) -> TestResult<u64> {
    let packs = dir.join(".git/objects/pack");
    let mut total = 0;
    for entry in std::fs::read_dir(&packs).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|e| e == "pack") {
            total += std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        }
    }
    Ok(total)
}

fn count(c: &Client, dir: &Path) -> TestResult<usize> {
    c.git(dir, &["rev-list", "--count", "HEAD"])?
        .parse()
        .map_err(|e| format!("rev-list --count: {e}"))
}

fn fsck(c: &Client, dir: &Path, what: &str) -> TestResult {
    let out = c.git_output(dir, &["fsck", "--no-progress"])?;
    check(
        out.status.success(),
        &format!("{what} fsck: {}", String::from_utf8_lossy(&out.stderr)),
    )
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli --test big_clone -- --include-ignored"]
fn partial_and_shallow_clones_over_protocol_v2() -> TestResult {
    let platform = Platform::start()?;
    let (repo, token) = platform.repo(&[])?;
    let url = format!("{}/git/{repo}.git", platform.origin);
    let writer = client(&platform, "writer", &token)?;
    let dir = writer.home.join("src");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    writer.git(&dir, &["init", "-q", "-b", "main", "."])?;
    writer.git(&dir, &["remote", "add", "origin", &url])?;
    // 200 files of 4 KiB in 10 directories, then 9 commits each rewriting 20 of them.
    for round in 0..COMMITS {
        let files: Vec<(String, String)> = (0..FILES)
            .filter(|i| round == 0 || i % COMMITS == round)
            .map(|i| {
                let seed = (round * FILES + i) as u64;
                (format!("d{}/f{i}.txt", i % 10), text(seed, 4096))
            })
            .collect();
        let refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(p, t)| (p.as_str(), t.as_str()))
            .collect();
        writer.commit(&dir, &format!("round {round}"), &refs)?;
    }
    let out = writer.git_output(&dir, &["push", "-q", "origin", "main"])?;
    check(
        out.status.success(),
        &format!("push: {}", String::from_utf8_lossy(&out.stderr)),
    )?;
    let head = writer.git(&dir, &["rev-parse", "HEAD"])?;

    // A full clone over version 0, unchanged.
    let reader = client(&platform, "reader", &token)?;
    let home = reader.home.clone();
    reader.git(
        &home,
        &["-c", "protocol.version=0", "clone", "-q", &url, "full"],
    )?;
    let full = home.join("full");
    check(count(&reader, &full)? == COMMITS, "full clone history")?;
    fsck(&reader, &full, "full")?;
    let full_bytes = pack_bytes(&full)?;

    // Partial: commits and trees only, then the checkout fetches main's files by id.
    reader.git(
        &home,
        &[
            "clone",
            "-q",
            "--filter=blob:none",
            "--no-checkout",
            &url,
            "partial",
        ],
    )?;
    let partial = home.join("partial");
    let partial_bytes = pack_bytes(&partial)?;
    eprintln!("full clone {full_bytes} bytes, partial clone {partial_bytes} bytes");
    check(
        partial_bytes * 10 < full_bytes,
        &format!("partial {partial_bytes} B is not < 10% of full {full_bytes} B"),
    )?;
    check(count(&reader, &partial)? == COMMITS, "partial history")?;
    reader.git(&partial, &["checkout", "-q", "main"])?;
    for i in [0, 57, 199] {
        let path = format!("d{}/f{i}.txt", i % 10);
        let local = std::fs::read_to_string(dir.join(&path)).map_err(|e| e.to_string())?;
        let fetched = std::fs::read_to_string(partial.join(&path)).unwrap_or_default();
        check(local == fetched, &format!("lazily fetched {path}"))?;
    }
    let missing = reader.git(
        &partial,
        &["rev-list", "--objects", "--all", "--missing=print"],
    )?;
    check(
        missing.lines().any(|l| l.starts_with('?')),
        "older blobs stay on the server",
    )?;
    // An old version's file is fetched on demand too.
    let old = reader.git(&partial, &["show", "HEAD~9:d3/f3.txt"])?;
    check(old == text(3, 4096).trim_end(), "old version fetched by id")?;
    fsck(&reader, &partial, "partial")?;

    // Shallow: one commit, then five more, then all of them.
    reader.git(&home, &["clone", "-q", "--depth", "1", &url, "shallow"])?;
    let shallow = home.join("shallow");
    check(count(&reader, &shallow)? == 1, "depth 1")?;
    check(shallow.join(".git/shallow").exists(), "shallow file")?;
    check(
        reader.git(&shallow, &["rev-parse", "HEAD"])? == head,
        "shallow HEAD",
    )?;
    fsck(&reader, &shallow, "depth 1")?;
    reader.git(&shallow, &["fetch", "-q", "--deepen", "5"])?;
    check(count(&reader, &shallow)? == 6, "deepened by 5")?;
    fsck(&reader, &shallow, "deepened")?;
    reader.git(&shallow, &["fetch", "-q", "--unshallow"])?;
    check(count(&reader, &shallow)? == COMMITS, "unshallowed")?;
    check(!shallow.join(".git/shallow").exists(), "no longer shallow")?;
    fsck(&reader, &shallow, "unshallowed")?;
    // Partial and shallow at once.
    reader.git(
        &home,
        &[
            "clone",
            "-q",
            "--depth",
            "1",
            "--filter=blob:none",
            &url,
            "both",
        ],
    )?;
    let both = home.join("both");
    check(count(&reader, &both)? == 1, "partial shallow history")?;
    fsck(&reader, &both, "partial shallow")
}
