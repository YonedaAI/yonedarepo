//! Big-repository clones with stock `git` over the local platform's smart HTTP (protocol
//! version 2): a partial clone (`--filter=blob:none`) receives commits and trees only and
//! fetches the files a checkout needs lazily, by id; a shallow clone (`--depth 1`) deepens
//! (`git fetch --deepen 5`) and unshallows; every result passes `git fsck`, and a
//! version 0 clone still works. A commit or blob wanted by id is served only when a
//! branch or tag reaches it: never from a push refused for a secret or a read conflict, or
//! a deleted branch. A partial clone's checkout of more than 10,000 files fetches them all. Run with `cargo test -p yoneda-cli --test big_clone --
//! --include-ignored --nocapture`; it needs the workspace's node modules (wrangler) and
//! the Rust Wasm worker build.
#[allow(dead_code)] // shared with the remote helper tests
mod support;

use base64::Engine;
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
    // No background repack after a fetch: it races `git fsck` on the packs.
    client.git(&home, &["config", "--global", "maintenance.auto", "false"])?;
    client.git(&home, &["config", "--global", "gc.auto", "0"])?;
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
    fsck(&reader, &both, "partial shallow")?;
    unreachable_blobs_are_not_served(&platform)?;
    big_checkout(&platform)
}

/// A partial clone's checkout of 10,200 files: Git wants every one in one fetch.
fn big_checkout(platform: &Platform) -> TestResult {
    const BIG: usize = 10_200;
    let (repo, token) = platform.repo(&[("README.md", "# big\n")])?;
    let url = format!("{}/git/{repo}.git", platform.origin);
    let writer = client(platform, "big-writer", &token)?;
    writer.git(&writer.home, &["clone", "-q", &url, "src"])?;
    let src = writer.home.join("src");
    for i in 0..BIG {
        let path = src.join(format!("big/d{:03}/f{i}.txt", i % 100));
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, format!("file {i}\n")).map_err(|e| e.to_string())?;
    }
    writer.git(&src, &["add", "-A"])?;
    writer.git(&src, &["commit", "-q", "-m", "many files"])?;
    let out = writer.git_output(&src, &["push", "-q", "origin", "main"])?;
    check(
        out.status.success(),
        &format!("big push: {}", String::from_utf8_lossy(&out.stderr)),
    )?;
    let reader = client(platform, "big-reader", &token)?;
    let home = reader.home.clone();
    reader.git(
        &home,
        &[
            "clone",
            "-q",
            "--filter=blob:none",
            "--no-checkout",
            &url,
            "c",
        ],
    )?;
    let dir = home.join("c");
    let started = std::time::Instant::now();
    let out = reader.git_output(&dir, &["checkout", "-q", "main"])?;
    check(
        out.status.success(),
        &format!("big checkout: {}", String::from_utf8_lossy(&out.stderr)),
    )?;
    eprintln!(
        "checkout of {BIG} lazily fetched files: {} ms",
        started.elapsed().as_millis()
    );
    let listed = reader.git(&dir, &["ls-files"])?.lines().count();
    check(listed == BIG + 1, &format!("{listed} files checked out"))?;
    let sample = std::fs::read_to_string(dir.join("big/d042/f10142.txt")).unwrap_or_default();
    check(sample == "file 10142\n", "a fetched file")?;
    fsck(&reader, &dir, "big checkout")
}

fn pkt(line: &str) -> String {
    format!("{:04x}{line}", line.len() + 4)
}

/// A raw fetch of `id`: protocol v2 as a partial clone's lazy fetch asks, or v0 (`git
/// fetch origin <id>` from an older Git). The answer, whatever its status.
fn fetch_by_id(platform: &Platform, repo: &str, token: &str, id: &str) -> TestResult<String> {
    fetch_raw(platform, repo, token, id, 2)
}

fn fetch_raw(
    platform: &Platform,
    repo: &str,
    token: &str,
    id: &str,
    version: u8,
) -> TestResult<String> {
    let body = if version == 2 {
        format!(
            "{}0001{}{}{}0000",
            pkt("command=fetch\n"),
            pkt(&format!("want {id}\n")),
            pkt("filter blob:none\n"),
            pkt("done\n")
        )
    } else {
        format!(
            "{}0000{}",
            pkt(&format!("want {id} side-band-64k\n")),
            pkt("done\n")
        )
    };
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("git:{token}"));
    let url = format!("{}/git/{repo}.git/git-upload-pack", platform.origin);
    platform.rt.block_on(async {
        let mut request = reqwest::Client::new()
            .post(url)
            .header("authorization", format!("Basic {auth}"));
        if version == 2 {
            request = request.header("git-protocol", "version=2");
        }
        let response = request.body(body).send().await.map_err(|e| e.to_string())?;
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
}

fn refused(answer: &str, what: &str) -> TestResult {
    check(
        !answer.contains("PACK") && answer.contains("not our ref"),
        &format!("{what} was served: {}", &answer[..answer.len().min(200)]),
    )
}

/// Blobs a branch or tag does not reach stay unserved, whatever the store holds: a push
/// refused for a secret (scanned before anything is stored), one refused at the ref move
/// for a stale declared read (its commit and blobs are recorded), and a deleted branch.
fn unreachable_blobs_are_not_served(platform: &Platform) -> TestResult {
    let (repo, token) = platform.repo(&[("config.json", "{\"v\":1}\n"), ("app.js", "a\n")])?;
    let url = format!("{}/git/{repo}.git", platform.origin);
    let (a, b) = (
        client(platform, "hidden-a", &token)?,
        client(platform, "hidden-b", &token)?,
    );
    a.git(&a.home, &["clone", "-q", &url, "w"])?;
    b.git(&b.home, &["clone", "-q", &url, "w"])?;
    let (da, db) = (a.home.join("w"), b.home.join("w"));
    let blob =
        |c: &Client, dir: &Path, path: &str| c.git(dir, &["rev-parse", &format!("HEAD:{path}")]);
    // Reachable: main's file is served by id.
    let served = fetch_by_id(platform, &repo, &token, &blob(&a, &da, "app.js")?)?;
    check(served.contains("PACK"), "main's blob by id")?;

    let fake = ["gh", "p_"].concat()
        + &"aB3dE5gH7jK9mN1pQ"
            .chars()
            .cycle()
            .take(36)
            .collect::<String>();
    a.commit(
        &da,
        "leak",
        &[("env.ts", &format!("const t = \"{fake}\";\n"))],
    )?;
    let leak = blob(&a, &da, "env.ts")?;
    let out = a.git_output(&da, &["push", "origin", "HEAD:refs/heads/leak"])?;
    check(!out.status.success(), "secret push refused")?;
    refused(
        &fetch_by_id(platform, &repo, &token, &leak)?,
        "a secret-refused blob",
    )?;
    a.git(&da, &["reset", "-q", "--hard", "HEAD~1"])?;

    a.commit(
        &da,
        "app relies on config v1",
        &[("app.js", "only in a refused push\n")],
    )?;
    let stale = blob(&a, &da, "app.js")?;
    b.commit(&db, "config v2", &[("config.json", "{\"v\":2}\n")])?;
    b.git(&db, &["push", "-q", "origin", "main"])?;
    let out = a.git_output(
        &da,
        &["push", "-o", "yoneda.reads=config.json", "origin", "main"],
    )?;
    check(!out.status.success(), "stale read refused")?;
    let mine = a.git(&da, &["rev-parse", "HEAD"])?;
    check(
        platform
            .owner_call("GET", &format!("/repos/{repo}/commits/{mine}"), None)
            .is_ok(),
        "the refused push's commit is recorded",
    )?;
    refused(
        &fetch_by_id(platform, &repo, &token, &stale)?,
        "a blob of a refused ref move",
    )?;
    // Nor its commit, over either protocol (with it, its trees and files).
    for version in [0, 2] {
        refused(
            &fetch_raw(platform, &repo, &token, &mine, version)?,
            &format!("the refused push's commit over v{version}"),
        )?;
    }
    let main = platform.main(&repo)?.1;
    check(
        fetch_raw(platform, &repo, &token, &main, 0)?.contains("PACK"),
        "main's tip over v0",
    )?;

    b.commit(&db, "tmp", &[("tmp.txt", "only on a deleted branch\n")])?;
    let gone = blob(&b, &db, "tmp.txt")?;
    b.git(&db, &["push", "-q", "origin", "HEAD:refs/heads/tmp"])?;
    check(
        fetch_by_id(platform, &repo, &token, &gone)?.contains("PACK"),
        "a branch's blob is served",
    )?;
    b.git(&db, &["push", "-q", "origin", ":refs/heads/tmp"])?;
    refused(
        &fetch_by_id(platform, &repo, &token, &gone)?,
        "a deleted branch's blob",
    )
}
