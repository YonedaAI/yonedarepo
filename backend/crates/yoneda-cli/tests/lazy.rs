//! Lazy `yoneda::` clones against the local platform: a clone brings commits and trees, Git
//! fetches each blob through the helper the first time it needs it, a sparse clone fetches
//! nothing outside its directories, and the fetch-efficiency tally matches what the clone
//! holds. Synthetic repositories only. Run with `cargo test -p yoneda-cli --test lazy --
//! --include-ignored`; it needs the workspace's node modules and the Rust Wasm worker build.
#[allow(dead_code)] // shared with the other platform tests
mod support;

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use support::proxy::Proxy;
use support::{Client, Platform, TestResult};

fn check(condition: bool, what: &str) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(what.to_owned())
    }
}

/// Objects and bytes by kind from a clone's `.git/yoneda/fetched`.
fn fetched(dir: &Path) -> HashMap<String, (u64, u64)> {
    let text = std::fs::read_to_string(dir.join(".git/yoneda/fetched")).unwrap_or_default();
    let mut by_kind: HashMap<String, (u64, u64)> = HashMap::new();
    for line in text.lines() {
        let words: Vec<&str> = line.split(' ').collect();
        if let [kind, count, bytes] = words[..] {
            let entry = by_kind.entry(kind.to_owned()).or_default();
            entry.0 += count.parse::<u64>().unwrap_or(0);
            entry.1 += bytes.parse::<u64>().unwrap_or(0);
        }
    }
    by_kind
}

fn blobs(dir: &Path) -> u64 {
    fetched(dir).get("blob").map_or(0, |(n, _)| *n)
}

/// Whether the clone holds `id`, never fetching it (no helper on `PATH`, no lazy fetch).
fn holds(dir: &Path, id: &str) -> TestResult<bool> {
    let status = std::process::Command::new("git")
        .args(["cat-file", "-e", id])
        .current_dir(dir)
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("PATH", "/usr/bin:/bin")
        .status()
        .map_err(|e| e.to_string())?;
    Ok(status.success())
}

struct World {
    platform: Platform,
    proxy: Proxy,
}

impl World {
    fn url(&self, repo: &str) -> String {
        format!("yoneda::{}/{repo}", self.proxy.origin)
    }

    fn client(&self, name: &str, token: &str) -> TestResult<Client> {
        let home = self.platform.scratch.path().join(format!("home-{name}"));
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        Ok(Client {
            home,
            token: token.to_owned(),
        })
    }

    fn requests(&self) -> usize {
        self.proxy.with(|s| s.log.len())
    }

    /// The requests since `mark`, as `METHOD path` lines.
    fn since(&self, mark: usize) -> Vec<String> {
        self.proxy.with(|s| {
            s.log[mark..]
                .iter()
                .map(|(m, p)| format!("{m} {}", p.split('?').next().unwrap_or(p)))
                .collect()
        })
    }

    /// A repository with three commits of history: seven files at the tip in nested
    /// directories; the second commit changed `a/x/f1.txt` and `b/h1.txt`, the third
    /// `b/deep/i.txt`.
    fn history(&self) -> TestResult<(String, String)> {
        let (repo, token) = self.platform.repo(&[
            ("README.md", "top\n"),
            ("a/x/f1.txt", "f1 v1\n"),
            ("a/x/f2.txt", "f2\n"),
            ("a/y/g.txt", "g\n"),
            ("b/h1.txt", "h1 v1\n"),
            ("b/h2.txt", "h2\n"),
            ("b/deep/i.txt", "i v1\n"),
        ])?;
        self.platform
            .other_writer(&repo, &[("a/x/f1.txt", "f1 v2\n"), ("b/h1.txt", "h1 v2\n")])?;
        self.platform
            .other_writer(&repo, &[("b/deep/i.txt", "i v2\n")])?;
        Ok((repo, token))
    }
}

/// Clone, open one file, check out another commit: requests and blobs, full against lazy.
fn lazy_clone_fetches_blobs_on_first_use(w: &World) -> TestResult {
    let (repo, token) = w.history()?;
    let c = w.client("lazy", &token)?;
    let mut table = Vec::new();
    for lazy in [false, true] {
        let name = if lazy { "lazy" } else { "full" };
        let mark = w.requests();
        let mut clone = vec!["clone", "-q", "--no-checkout"];
        if !lazy {
            clone.extend(["-c", "yoneda.lazy=false"]);
        }
        let url = w.url(&repo);
        clone.extend([url.as_str(), name]);
        c.git(&c.home, &clone)?;
        let dir = c.home.join(name);
        let cloned = w.since(mark);
        let promisor = c
            .git(&dir, &["config", "remote.origin.promisor"])
            .unwrap_or_default();
        check(
            (promisor == "true") == lazy,
            &format!("{name}: promisor remote {promisor:?}"),
        )?;
        let after_clone = blobs(&dir);
        if lazy {
            check(
                after_clone == 0,
                &format!("a lazy clone fetched {after_clone} blobs"),
            )?;
        } else {
            // Every blob of the history: 7 at the tip and 3 older versions.
            check(
                after_clone == 10,
                &format!("a full clone fetched {after_clone} blobs"),
            )?;
        }

        let mark = w.requests();
        let shown = c.git(&dir, &["show", "HEAD:a/y/g.txt"])?;
        check(shown == "g", &format!("{name}: show {shown:?}"))?;
        let opened = w.since(mark);
        check(
            blobs(&dir) == after_clone + u64::from(lazy),
            &format!(
                "{name}: opening one file fetched {} blobs",
                blobs(&dir) - after_clone
            ),
        )?;

        // Git log reads commits only; the clone holds them all.
        let before_log = fetched(&dir);
        let log = c.git(&dir, &["log", "--oneline"])?;
        check(log.lines().count() == 3, &format!("{name}: log {log}"))?;
        check(
            fetched(&dir) == before_log,
            &format!("{name}: git log fetched"),
        )?;

        c.git(&dir, &["checkout", "-q", "-f", "main"])?;
        check(
            std::fs::read_to_string(dir.join("b/deep/i.txt")).unwrap_or_default() == "i v2\n",
            &format!("{name}: checkout"),
        )?;
        let at_tip = blobs(&dir);
        if lazy {
            check(
                at_tip == 7,
                &format!("the checkout left {at_tip} blobs fetched"),
            )?;
        }
        // Back two commits: three files differ, so exactly their older versions come.
        let mark = w.requests();
        c.git(&dir, &["checkout", "-q", "HEAD~2"])?;
        let moved = w.since(mark);
        check(
            std::fs::read_to_string(dir.join("a/x/f1.txt")).unwrap_or_default() == "f1 v1\n",
            &format!("{name}: older checkout"),
        )?;
        let changed = blobs(&dir) - at_tip;
        check(
            changed == if lazy { 3 } else { 0 },
            &format!("{name}: checking out HEAD~2 fetched {changed} blobs"),
        )?;
        c.git(&dir, &["checkout", "-q", "main"])?;
        let blame = c.git(&dir, &["blame", "--porcelain", "b/h1.txt"])?;
        check(blame.contains("h1 v2"), &format!("{name}: blame {blame}"))?;
        let patch = c.git(&dir, &["log", "-p", "--format=%s"])?;
        check(patch.contains("+i v2"), &format!("{name}: log -p"))?;
        table.push(format!(
            "{name}: clone {} requests ({} blobs); open 1 file {} requests; checkout HEAD~2 {} requests ({changed} blobs)\n  clone: {cloned:?}\n  open: {opened:?}\n  checkout: {moved:?}",
            cloned.len(),
            after_clone,
            opened.len(),
            moved.len(),
        ));
    }
    eprintln!("lazy fetch request counts\n{}", table.join("\n"));

    // A push carries a file the clone never fetched (renamed, never opened): the helper
    // reads its blob, which Git fetches for it.
    c.git(
        &c.home,
        &["clone", "-q", "--no-checkout", &w.url(&repo), "rename"],
    )?;
    let dir = c.home.join("rename");
    c.git(&dir, &["read-tree", "HEAD"])?;
    let blob = c.git(&dir, &["rev-parse", "HEAD:b/h2.txt"])?;
    check(!holds(&dir, &blob)?, "the renamed blob is not fetched yet")?;
    c.git(&dir, &["rm", "-q", "--cached", "b/h2.txt"])?;
    c.git(
        &dir,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{blob},b/h2-renamed.txt"),
        ],
    )?;
    c.git(&dir, &["commit", "-q", "-m", "rename an unread file"])?;
    let pushed = c.git_output(&dir, &["push", "origin", "HEAD:refs/heads/renamed"])?;
    check(
        pushed.status.success(),
        &format!("push: {}", String::from_utf8_lossy(&pushed.stderr)),
    )?;
    let renamed = w.platform.owner_call(
        "GET",
        &format!("/repos/{repo}/blob?ref=renamed&path=b/h2-renamed.txt"),
        None,
    )?;
    check(
        renamed["content"] == "h2\n",
        &format!("renamed on the platform: {renamed}"),
    )
}

/// `yoneda clone --sparse a/x`: nothing outside the cone (a/x and the top's files) is
/// fetched, in any commit; `yoneda sparse --add` widens it.
fn sparse_clone_stays_in_scope(w: &World) -> TestResult {
    let (repo, token) = w.history()?;
    let c = w.client("sparse", &token)?;
    let origin = w.proxy.origin.clone();
    c.git(
        &c.home,
        &[
            "clone",
            "-q",
            "-c",
            "yoneda.lazy=false",
            &w.url(&repo),
            "every",
        ],
    )?;
    let every = c.home.join("every");
    c.ok(
        &c.home,
        &[
            "clone", &repo, "part", "--sparse", "a/x", "--origin", &origin,
        ],
    )?;
    let dir = c.home.join("part");
    for (path, there) in [
        ("README.md", true),
        ("a/x/f1.txt", true),
        ("a/x/f2.txt", true),
        ("a/y/g.txt", false),
        ("b/h1.txt", false),
    ] {
        check(
            dir.join(path).exists() == there,
            &format!("{path} checked out: {}", !there),
        )?;
    }
    check(
        blobs(&dir) == 3,
        &format!("the sparse clone fetched {} blobs", blobs(&dir)),
    )?;
    // Every object of the history by path: outside the cone none is held.
    let listed = c.git(&every, &["rev-list", "--objects", "--all"])?;
    let mut outside = 0;
    for line in listed.lines() {
        let Some((id, path)) = line.split_once(' ') else {
            continue;
        };
        let inside = path.is_empty()
            || path == "README.md"
            || path == "a"
            || path == "a/x"
            || path.starts_with("a/x/");
        if !inside {
            outside += 1;
            check(!holds(&dir, id)?, &format!("{path} ({id}) was fetched"))?;
        }
    }
    check(
        outside >= 8,
        &format!("only {outside} objects outside the cone"),
    )?;
    check(
        c.git(&dir, &["status", "--porcelain"])?.is_empty(),
        "status is clean",
    )?;
    check(
        c.git(&dir, &["log", "--oneline"])?.lines().count() == 3,
        "log in a sparse clone",
    )?;

    c.ok(&dir, &["sparse", "--add", "b"])?;
    check(
        std::fs::read_to_string(dir.join("b/deep/i.txt")).unwrap_or_default() == "i v2\n"
            && dir.join("a/x/f1.txt").exists()
            && !dir.join("a/y").exists(),
        "widened to b",
    )?;
    let g = c.git(&every, &["rev-parse", "HEAD:a/y"])?;
    check(!holds(&dir, &g)?, "a/y is still outside")?;
    // A tree outside the scope comes on demand, by id, like a blob.
    let shown = c.git(&dir, &["ls-tree", "--name-only", "HEAD:a/y"])?;
    check(
        shown == "g.txt",
        &format!("ls-tree outside the scope: {shown}"),
    )
}

/// The tally a session record carries: every byte the clone holds was fetched and counted,
/// and the files the agent read are sized.
fn session_records_carry_fetch_efficiency(w: &World) -> TestResult {
    let (repo, token) = w.history()?;
    let c = w.client("efficiency", &token)?;
    c.git(&c.home, &["clone", "-q", &w.url(&repo), "w"])?;
    let dir = c.home.join("w");
    let sizes = c.git(
        &dir,
        &[
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectsize)",
        ],
    )?;
    let held: u64 = sizes.lines().filter_map(|s| s.parse::<u64>().ok()).sum();
    let counted: u64 = fetched(&dir).values().map(|(_, b)| *b).sum();
    check(
        counted == held,
        &format!("fetched {counted} bytes, the clone holds {held}"),
    )?;
    let read = json!({ "cwd": dir, "tool_name": "Read",
        "tool_input": { "file_path": dir.join("a/x/f1.txt") } });
    let out = c.yoneda_input(&dir, &["hook", "claude-read"], &read.to_string())?;
    check(out.status.success(), "read hook")?;
    let mine = c.commit(&dir, "edit", &[("a/x/f2.txt", "f2 edited\n")])?;
    let pushed = c.git_output(&dir, &["push", "origin", "HEAD:refs/heads/edit"])?;
    check(
        pushed.status.success(),
        &format!("push: {}", String::from_utf8_lossy(&pushed.stderr)),
    )?;
    let stop = json!({ "cwd": dir, "session_id": "s1" });
    let out = c.yoneda_input(&dir, &["hook", "claude-stop"], &stop.to_string())?;
    check(
        out.status.success(),
        &format!("stop hook: {}", String::from_utf8_lossy(&out.stderr)),
    )?;
    let listed = w.platform.owner_call(
        "GET",
        &format!("/repos/{repo}/commits/{mine}/sessions"),
        None,
    )?;
    let record: &Value = &listed["sessions"][0];
    check(
        record["fetched_bytes"] == json!(held) && record["read_bytes"] == json!(6),
        &format!("the record's efficiency: {record}"),
    )
}

/// A repository with 240 historical blobs: `keep/` (two files) and `far/d0..d3/` (ten
/// files each), then six commits that each rewrite every `far/` file.
fn long_history(w: &World) -> TestResult<(String, String)> {
    let far = |round: usize| -> Vec<(String, String)> {
        (0..4)
            .flat_map(|d| (0..10).map(move |f| (d, f)))
            .map(|(d, f)| (format!("far/d{d}/f{f}.txt"), format!("{d}.{f} v{round}\n")))
            .collect()
    };
    let mut seed = vec![
        ("keep/a.txt".to_owned(), "a\n".to_owned()),
        ("keep/b.txt".to_owned(), "b\n".to_owned()),
    ];
    seed.extend(far(0));
    let files: Vec<(&str, &str)> = seed.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
    let (repo, token) = w.platform.repo(&files)?;
    for round in 1..=6 {
        let changed = far(round);
        let files: Vec<(&str, &str)> = changed
            .iter()
            .map(|(p, t)| (p.as_str(), t.as_str()))
            .collect();
        w.platform.other_writer(&repo, &files)?;
    }
    Ok((repo, token))
}

/// Lazy clones edit one file and push: the push reads no other blob (none of the tip's
/// files outside the cone, none of the history) and fetches nothing. `part` is `yoneda clone
/// --sparse` (no trees outside the cone); `cone` is the real-user agents' clone (`git clone
/// --no-checkout`, then Git's cone sparse-checkout: every tree, no blob outside the cone).
fn push_from_a_sparse_clone_fetches_nothing(w: &World, repo: &str, c: &Client) -> TestResult {
    let origin = w.proxy.origin.clone();
    c.ok(
        &c.home,
        &[
            "clone", repo, "part", "--sparse", "keep", "--origin", &origin,
        ],
    )?;
    let url = w.url(repo);
    c.git(&c.home, &["clone", "-q", "--no-checkout", &url, "cone"])?;
    let cone = c.home.join("cone");
    c.git(
        &cone,
        &["sparse-checkout", "set", "--cone", "--sparse-index", "keep"],
    )?;
    c.git(&cone, &["switch", "-q", "-c", "work", "origin/main"])?;
    for name in ["cone", "part"] {
        let dir = c.home.join(name);
        check(
            blobs(&dir) == 2,
            &format!("{name}: the clone fetched {} blobs", blobs(&dir)),
        )?;
        let text = format!("a edited in {name}\n");
        c.commit(&dir, "edit one file", &[("keep/a.txt", &text)])?;
        let before = fetched(&dir);
        let branch = format!("HEAD:refs/heads/edit-{name}");
        let pushed = c.git_output(&dir, &["push", "origin", &branch])?;
        check(
            pushed.status.success(),
            &format!("{name}: push: {}", String::from_utf8_lossy(&pushed.stderr)),
        )?;
        // Nothing arrived: no blob, and no tree outside the cone.
        check(
            fetched(&dir) == before,
            &format!(
                "{name}: the push fetched {:?} after {before:?}",
                fetched(&dir)
            ),
        )?;
        let edited = w.platform.owner_call(
            "GET",
            &format!("/repos/{repo}/blob?ref=edit-{name}&path=keep/a.txt"),
            None,
        )?;
        check(
            edited["content"] == text.as_str(),
            &format!("{name}: edited on the platform: {edited}"),
        )?;
    }
    Ok(())
}

/// A commit (built with plumbing, so the person's Git never reads the blob) copies a file
/// from outside the cone into it: the push fetches exactly that blob, and sends it.
fn push_of_an_unread_blob_fetches_only_it(w: &World, repo: &str, c: &Client) -> TestResult {
    let dir = c.home.join("part");
    c.git(&dir, &["checkout", "-q", "-b", "moved", "origin/main"])?;
    let blob = c.git(&dir, &["rev-parse", "HEAD:far/d2/f7.txt"])?;
    check(!holds(&dir, &blob)?, "the moved blob is not fetched yet")?;
    c.git(
        &dir,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("100644,{blob},keep/moved.txt"),
        ],
    )?;
    let tree = c.git(&dir, &["write-tree", "--missing-ok"])?;
    let commit = c.git(
        &dir,
        &[
            "commit-tree",
            &tree,
            "-p",
            "HEAD",
            "-m",
            "copy an unread file",
        ],
    )?;
    c.git(&dir, &["update-ref", "HEAD", &commit])?;
    check(!holds(&dir, &blob)?, "committing did not fetch the blob")?;
    let before = blobs(&dir);
    let pushed = c.git_output(&dir, &["push", "origin", "HEAD:refs/heads/moved"])?;
    check(
        pushed.status.success(),
        &format!("push: {}", String::from_utf8_lossy(&pushed.stderr)),
    )?;
    check(
        blobs(&dir) == before + 1,
        &format!("the push fetched {} blobs", blobs(&dir) - before),
    )?;
    let moved = w.platform.owner_call(
        "GET",
        &format!("/repos/{repo}/blob?ref=moved&path=keep/moved.txt"),
        None,
    )?;
    check(
        moved["content"] == "2.7 v6\n",
        &format!("moved on the platform: {moved}"),
    )
}

/// Fifty historical blobs, each fetched alone by Git's lazy fetch through the helper.
fn single_blob_fetches_are_reliable(w: &World, repo: &str, c: &Client) -> TestResult {
    c.git(
        &c.home,
        &["clone", "-q", "--no-checkout", &w.url(repo), "fifty"],
    )?;
    let dir = c.home.join("fifty");
    let listed = c.git(&dir, &["rev-list", "--objects", "--missing=print", "--all"])?;
    let ids: Vec<&str> = listed
        .lines()
        .filter_map(|l| l.strip_prefix('?'))
        .take(50)
        .collect();
    check(ids.len() == 50, &format!("{} absent blobs", ids.len()))?;
    for (n, id) in ids.iter().enumerate() {
        let out = c.git_output(&dir, &["cat-file", "-p", id])?;
        check(
            out.status.success() && holds(&dir, id)?,
            &format!(
                "lazy fetch {n} of {id}: {}",
                String::from_utf8_lossy(&out.stderr)
            ),
        )?;
    }
    check(
        blobs(&dir) == 50,
        &format!("fifty fetches brought {} blobs", blobs(&dir)),
    )
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli --test lazy -- --include-ignored"]
fn lazy_pushes_send_only_their_own_commits() -> TestResult {
    let platform = Platform::start()?;
    let proxy = Proxy::start(&platform.origin)?;
    let w = World { platform, proxy };
    let (repo, token) = long_history(&w)?;
    let c = w.client("push", &token)?;
    push_from_a_sparse_clone_fetches_nothing(&w, &repo, &c).map_err(|e| format!("edit: {e}"))?;
    push_of_an_unread_blob_fetches_only_it(&w, &repo, &c).map_err(|e| format!("move: {e}"))?;
    single_blob_fetches_are_reliable(&w, &repo, &c).map_err(|e| format!("fifty: {e}"))
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli --test lazy -- --include-ignored"]
fn lazy_clones_fetch_only_what_git_needs() -> TestResult {
    let platform = Platform::start()?;
    let proxy = Proxy::start(&platform.origin)?;
    let w = World { platform, proxy };
    lazy_clone_fetches_blobs_on_first_use(&w).map_err(|e| format!("lazy: {e}"))?;
    sparse_clone_stays_in_scope(&w).map_err(|e| format!("sparse: {e}"))?;
    session_records_carry_fetch_efficiency(&w).map_err(|e| format!("efficiency: {e}"))
}
