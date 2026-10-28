//! Plain Git against the local platform through `git-remote-yoneda`, plus the account
//! commands. One platform (and one recording proxy in front of it) serves every scenario,
//! each on its own repository. Run with `cargo test -p yoneda-cli -- --include-ignored`;
//! it needs the workspace's node modules (wrangler) and the Rust Wasm worker build.
#[allow(dead_code)] // shared with the offline-checkout tests
mod support;

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::{Duration, Instant};
use support::proxy::{Interpose, Proxy};
use support::{Client, Platform, TestResult};

const LINES: &str = "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";

fn check(condition: bool, what: &str) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(what.to_owned())
    }
}

fn text(out: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

fn write(dir: &Path, path: &str, body: &str) -> TestResult {
    let full = dir.join(path);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(full, body).map_err(|e| e.to_string())
}

/// The repository id a command printed as `(<id>)`.
fn repo_id(out: &str) -> TestResult<&str> {
    out.find("(r")
        .and_then(|i| out.get(i + 1..i + 22))
        .ok_or(format!("no repository id in {out}"))
}

fn read(dir: &Path, path: &str) -> String {
    std::fs::read_to_string(dir.join(path)).unwrap_or_default()
}

struct World {
    platform: Platform,
    proxy: Proxy,
}

impl World {
    fn client(&self, name: &str, token: &str) -> TestResult<Client> {
        let home = self.platform.scratch.path().join(format!("home-{name}"));
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        Ok(Client {
            home,
            token: token.to_owned(),
        })
    }

    fn url(&self, repo: &str) -> String {
        format!("yoneda::{}/{repo}", self.proxy.origin)
    }

    /// `git clone` of `repo` into the client's home as `dir`.
    fn clone(&self, client: &Client, repo: &str, dir: &str) -> TestResult<PathBuf> {
        let out = client.git_output(&client.home, &["clone", &self.url(repo), dir])?;
        check(out.status.success(), &format!("clone: {}", text(&out)))?;
        Ok(client.home.join(dir))
    }

    fn main_tree(&self, repo: &str) -> TestResult<String> {
        Ok(self.platform.main(repo)?.2)
    }

    fn tree_of(&self, repo: &str, commit: &str) -> TestResult<String> {
        let shown =
            self.platform
                .owner_call("GET", &format!("/repos/{repo}/commits/{commit}"), None)?;
        Ok(shown["tree"].as_str().unwrap_or_default().to_owned())
    }

    fn refs(&self, repo: &str) -> TestResult<Value> {
        Ok(self
            .platform
            .owner_call("GET", &format!("/repos/{repo}/refs"), None)?["refs"]
            .clone())
    }

    fn blob_at(&self, repo: &str, branch: &str, path: &str) -> String {
        self.platform
            .owner_call(
                "GET",
                &format!("/repos/{repo}/blob?ref={branch}&path={path}"),
                None,
            )
            .map(|b| b["content"].as_str().unwrap_or_default().to_owned())
            .unwrap_or_default()
    }

    fn blob(&self, repo: &str, path: &str) -> String {
        self.platform
            .blob(repo, path)
            .map(|b| b["content"].as_str().unwrap_or_default().to_owned())
            .unwrap_or_default()
    }
}

fn commit(
    client: &Client,
    dir: &Path,
    message: &str,
    files: &[(&str, &str)],
) -> TestResult<String> {
    client.commit(dir, message, files)
}

fn push(client: &Client, dir: &Path, args: &[&str]) -> TestResult<Output> {
    let mut all = vec!["push"];
    all.extend(args);
    client.git_output(dir, &all)
}

fn clone_push_branch_and_land(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n"), ("f.txt", LINES)])?;
    let c = w.client("basics", &token)?;
    let dir = w.clone(&c, &repo, "work")?;
    check(read(&dir, "a.txt") == "a\n", "cloned files")?;
    check(
        c.git(&dir, &["rev-parse", "HEAD^{tree}"])? == w.main_tree(&repo)?,
        "clone tree",
    )?;

    c.git(&dir, &["checkout", "-q", "-b", "feature"])?;
    let local = commit(&c, &dir, "add b", &[("b.txt", "b\n")])?;
    let out = push(&c, &dir, &["origin", "feature"])?;
    check(
        out.status.success() && text(&out).contains("open a change: yoneda change create feature"),
        &format!("push branch: {}", text(&out)),
    )?;
    let feature = w.refs(&repo)?["refs/heads/feature"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    check(
        feature == local,
        &format!("the platform's branch head {feature} is the pushed commit {local}"),
    )?;
    let again = push(&c, &dir, &["origin", "feature"])?;
    check(
        text(&again).contains("Everything up-to-date"),
        &text(&again),
    )?;
    check(
        c.git(&dir, &["rev-parse", "origin/feature"])? == local,
        "tracking ref is the local commit",
    )?;

    c.git(&dir, &["reset", "-q", "--hard", "HEAD~1"])?;
    commit(&c, &dir, "add c", &[("c.txt", "c\n")])?;
    let refused = push(&c, &dir, &["origin", "feature"])?;
    check(
        !refused.status.success() && text(&refused).contains("rejected"),
        &text(&refused),
    )?;
    check(
        w.refs(&repo)?["refs/heads/feature"] == feature.as_str(),
        "refused push moved nothing",
    )?;
    let forced = push(&c, &dir, &["--force", "origin", "feature"])?;
    check(
        forced.status.success(),
        &format!("force: {}", text(&forced)),
    )?;
    check(
        w.refs(&repo)?["refs/heads/feature"] == c.git(&dir, &["rev-parse", "HEAD"])?.as_str(),
        "after a forced push, the platform's head is the local commit",
    )?;

    c.git(&dir, &["checkout", "-q", "main"])?;
    let pushed = commit(&c, &dir, "add d", &[("d.txt", "dee\n")])?;
    let landed = push(&c, &dir, &["origin", "main"])?;
    check(
        landed.status.success()
            && text(&landed).contains(&format!("landed as {}", &pushed[..12]))
            && text(&landed).contains("version"),
        &format!("push main: {}", text(&landed)),
    )?;
    // A plain push on top of main lands as exactly the pushed commit: no wrapper commit.
    check(
        w.refs(&repo)?["refs/heads/main"] == pushed.as_str(),
        &format!("main is the pushed commit {pushed}: {}", w.refs(&repo)?),
    )?;
    check(
        w.main_tree(&repo)? == c.git(&dir, &["rev-parse", "HEAD^{tree}"])?,
        "main tree",
    )?;
    let again = push(&c, &dir, &["origin", "main"])?;
    check(
        text(&again).contains("Everything up-to-date"),
        &text(&again),
    )?;
    // A fetch is a plain update (never forced) and a pull is a no-op fast-forward.
    let fetched = c.git_output(&dir, &["fetch", "origin"])?;
    check(
        fetched.status.success() && !text(&fetched).contains("forced update"),
        &format!("fetch: {}", text(&fetched)),
    )?;
    let main = w.refs(&repo)?["refs/heads/main"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    check(
        c.git(&dir, &["rev-parse", "origin/main"])? == main,
        "origin/main is the platform's main",
    )?;
    c.git(&dir, &["pull", "-q", "--ff-only", "origin", "main"])?;
    check(
        c.git(&dir, &["rev-parse", "HEAD"])? == main,
        "after a pull, HEAD is the platform's main",
    )?;
    let requests = |w: &World| {
        ["GET", "POST", "PUT", "DELETE"]
            .iter()
            .map(|m| w.proxy.count(m, ""))
            .sum::<usize>()
    };
    let before = requests(w);
    let brief = c.ok(&dir, &["status", "--brief"])?;
    check(
        brief.lines().count() == 1 && brief.contains("main: 0 commit(s) not on the platform"),
        &brief,
    )?;
    check(requests(w) == before, "status --brief makes no request")?;
    let log = c.ok(&dir, &["log"])?;
    check(log.contains("add d") || log.contains(&pushed), &log)?;
    check(
        log.starts_with(&main),
        &format!("log starts at main: {log}"),
    )?;
    let fsck = c.git_output(&dir, &["fsck", "--strict"])?;
    check(fsck.status.success(), &format!("fsck: {}", text(&fsck)))?;
    check(
        !dir.join(format!(".git/yoneda/{repo}.map")).exists(),
        "no commit needed a mapped id",
    )?;
    let hits = c.ok(&dir, &["grep", "dee"])?;
    check(hits.contains("d.txt"), &hits)
}

fn disjoint_pushes_to_main_both_land(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let (c1, c2) = (w.client("d1", &token)?, w.client("d2", &token)?);
    let (d1, d2) = (w.clone(&c1, &repo, "w")?, w.clone(&c2, &repo, "w")?);
    let x = commit(&c1, &d1, "x", &[("x.txt", "x\n")])?;
    let y = commit(&c2, &d2, "y", &[("y.txt", "y\n")])?;
    let first = push(&c1, &d1, &["origin", "main"])?;
    check(first.status.success(), &text(&first))?;
    let second = push(&c2, &d2, &["origin", "main"])?;
    check(
        second.status.success()
            && text(&second).contains("server merged concurrent changes")
            && text(&second).contains("git pull fast-forwards"),
        &format!("second push: {}", text(&second)),
    )?;
    check(
        w.blob(&repo, "x.txt") == "x\n" && w.blob(&repo, "y.txt") == "y\n",
        "both landed",
    )?;
    both_pull_fast_forward(w, &repo, [(&c1, &d1, &x), (&c2, &d2, &y)])?;

    // Pushed at the same moment: whatever batches they land in, both pullers fast-forward.
    let p = commit(&c1, &d1, "p", &[("p.txt", "p\n")])?;
    let q = commit(&c2, &d2, "q", &[("q.txt", "q\n")])?;
    let (one, two) = std::thread::scope(|s| {
        let one = s.spawn(|| push(&c1, &d1, &["origin", "main"]));
        let two = s.spawn(|| push(&c2, &d2, &["origin", "main"]));
        (one.join(), two.join())
    });
    for out in [one, two] {
        let out = out.map_err(|_| "a push thread panicked".to_owned())??;
        check(
            out.status.success(),
            &format!("concurrent push: {}", text(&out)),
        )?;
    }
    both_pull_fast_forward(w, &repo, [(&c1, &d1, &p), (&c2, &d2, &q)])
}

/// Every pusher's fetch is a plain update and its `git pull --ff-only` succeeds; main's
/// history holds each pushed commit by its own id.
fn both_pull_fast_forward(
    w: &World,
    repo: &str,
    pushers: [(&Client, &PathBuf, &str); 2],
) -> TestResult {
    let main = w.refs(repo)?["refs/heads/main"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    for (c, d, pushed) in pushers {
        let fetched = c.git_output(d, &["fetch", "origin"])?;
        check(
            fetched.status.success() && !text(&fetched).contains("forced update"),
            &format!("fetch: {}", text(&fetched)),
        )?;
        let pulled = c.git_output(d, &["pull", "-q", "--ff-only", "origin", "main"])?;
        check(pulled.status.success(), &format!("pull: {}", text(&pulled)))?;
        check(c.git(d, &["rev-parse", "HEAD"])? == main, "pulled to main")?;
        check(
            c.git_output(d, &["merge-base", "--is-ancestor", pushed, &main])?
                .status
                .success(),
            &format!("{pushed} is in main's history"),
        )?;
    }
    Ok(())
}

fn first_push_into_an_empty_repository(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[])?;
    check(w.refs(&repo)? == json!({}), "the repository starts empty")?;
    let c = w.client("empty", &token)?;
    let cloned = c.git_output(&c.home, &["clone", &w.url(&repo), "w"])?;
    check(
        cloned.status.success() && text(&cloned).contains("cloned an empty repository"),
        &format!("clone of an empty repository: {}", text(&cloned)),
    )?;
    let dir = c.home.join("w");
    c.git(&dir, &["checkout", "-q", "-b", "main"])?;
    let root = commit(&c, &dir, "root", &[("a.txt", "a\n")])?;
    let tip = commit(&c, &dir, "second", &[("b.txt", "b\n")])?;
    let pushed = push(&c, &dir, &["origin", "main"])?;
    check(
        pushed.status.success() && text(&pushed).contains(&format!("landed as {}", &tip[..12])),
        &format!("first push: {}", text(&pushed)),
    )?;
    check(
        w.refs(&repo)?["refs/heads/main"] == tip.as_str(),
        "main is the pushed commit",
    )?;
    check(
        w.platform
            .owner_call("GET", &format!("/repos/{repo}/commits/{tip}"), None)?["parents"]
            == json!([root]),
        "the pushed history keeps its ids",
    )?;
    // Plain Git from here on: a second clone, a push on top, a pull.
    let other = w.clone(&c, &repo, "again")?;
    check(c.git(&other, &["rev-parse", "HEAD"])? == tip, "fresh clone")?;
    let next = commit(&c, &other, "third", &[("c.txt", "c\n")])?;
    check(
        push(&c, &other, &["origin", "main"])?.status.success(),
        "push on top",
    )?;
    c.git(&dir, &["pull", "-q", "--ff-only", "origin", "main"])?;
    check(
        c.git(&dir, &["rev-parse", "HEAD"])? == next,
        "pull fast-forwards",
    )
}

fn same_line_overlap_conflicts_then_resolves(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("f.txt", LINES)])?;
    let (c1, c2) = (w.client("o1", &token)?, w.client("o2", &token)?);
    let (d1, d2) = (w.clone(&c1, &repo, "w")?, w.clone(&c2, &repo, "w")?);
    commit(&c1, &d1, "ours", &[("f.txt", &LINES.replace("l4", "one"))])?;
    commit(
        &c2,
        &d2,
        "theirs",
        &[("f.txt", &LINES.replace("l4", "two"))],
    )?;
    check(
        push(&c1, &d1, &["origin", "main"])?.status.success(),
        "first lands",
    )?;
    let refused = push(&c2, &d2, &["origin", "main"])?;
    let said = text(&refused);
    check(
        !refused.status.success() && said.contains("conflict") && said.contains("f.txt"),
        &said,
    )?;
    check(
        w.blob(&repo, "f.txt") == LINES.replace("l4", "one"),
        "main kept the first",
    )?;
    let listed = c2.ok(&d2, &["conflicts"])?;
    check(listed.contains("f.txt"), &listed)?;
    // Resolve the Git way: pull (merge), fix, commit, push.
    let _ = c2.git_output(&d2, &["pull", "-q", "--no-rebase", "origin", "main"])?;
    write(&d2, "f.txt", &LINES.replace("l4", "both"))?;
    c2.git(&d2, &["commit", "-q", "-am", "resolve"])?;
    let resolved = push(&c2, &d2, &["origin", "main"])?;
    check(
        resolved.status.success(),
        &format!("resolved push: {}", text(&resolved)),
    )?;
    check(
        w.blob(&repo, "f.txt") == LINES.replace("l4", "both"),
        "resolution landed",
    )
}

/// Declared reads through the helper (C1): `git push -o yoneda.reads=…` sends the read set
/// with the uploaded tip, and landing refuses it as a read conflict once B changed the read
/// file; the session's recorded reads (`yoneda reads add`) go with a plain `git push` after
/// `git pull`, which lands and clears them. Without a declaration the same work merges.
fn declared_reads_through_the_helper(w: &World) -> TestResult {
    let files = [("config.json", "{\"v\":1}\n"), ("app.js", "a\n")];
    for declare in [true, false] {
        let (repo, token) = w.platform.repo(&files)?;
        let (a, b) = (
            w.client(&format!("reads-a-{declare}"), &token)?,
            w.client(&format!("reads-b-{declare}"), &token)?,
        );
        let (da, db) = (w.clone(&a, &repo, "w")?, w.clone(&b, &repo, "w")?);
        let mine = commit(&a, &da, "app", &[("app.js", "a2\n")])?;
        commit(&b, &db, "config", &[("config.json", "{\"v\":2}\n")])?;
        check(
            push(&b, &db, &["origin", "main"])?.status.success(),
            "B lands first",
        )?;
        if !declare {
            let landed = push(&a, &da, &["origin", "main"])?;
            check(
                landed.status.success()
                    && text(&landed).contains("server merged concurrent changes"),
                &format!("undeclared: {}", text(&landed)),
            )?;
            continue;
        }
        let refused = push(
            &a,
            &da,
            &["-o", "yoneda.reads=config.json", "origin", "main"],
        )?;
        check(
            !refused.status.success()
                && text(&refused).contains("read conflict on config.json: run git pull"),
            &format!("declared: {}", text(&refused)),
        )?;
        let shown = w
            .platform
            .owner_call("GET", &format!("/repos/{repo}/commits/{mine}"), None)?;
        check(
            shown["read_set"] == json!(["config.json"]),
            &shown["read_set"].to_string(),
        )?;
        a.ok(&da, &["reads", "add", "config.json"])?;
        let pulled = a.git_output(&da, &["pull", "-q", "--no-rebase", "origin", "main"])?;
        check(pulled.status.success(), &format!("pull: {}", text(&pulled)))?;
        let landed = push(&a, &da, &["origin", "main"])?;
        check(
            landed.status.success(),
            &format!("after pull: {}", text(&landed)),
        )?;
        check(w.blob(&repo, "app.js") == "a2\n", "A's change landed")?;
        check(
            a.ok(&da, &["reads", "list"])?.trim().is_empty(),
            "reads cleared",
        )?;
        let pushed = std::fs::read_to_string(da.join(".git/yoneda/pushed")).unwrap_or_default();
        check(pushed.lines().count() == 1, &format!("pushed: {pushed}"))?;
    }
    Ok(())
}

fn atomic_push_with_a_stale_ref_moves_nothing(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("atomic", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    commit(&c, &dir, "start", &[("s.txt", "s\n")])?;
    let made = push(
        &c,
        &dir,
        &["origin", "HEAD:refs/heads/b1", "HEAD:refs/heads/b2"],
    )?;
    check(made.status.success(), &text(&made))?;
    let before = w.refs(&repo)?;
    let other = w.platform.owner_call(
        "POST",
        &format!("/repos/{repo}/commits"),
        Some(json!({ "ref": "main", "message": "elsewhere", "author": { "name": "O", "email": "o@example.com" },
                     "changes": [support::file("o.txt", "o\n")] })),
    )?;
    let moved = other["commit"].as_str().unwrap_or_default().to_owned();
    w.proxy.with(|s| {
        s.before_batch = Some(Interpose {
            path: format!("/api/v1/repos/{repo}/branches"),
            body: json!({ "ref": "refs/heads/b1", "commit": moved, "expected": before["refs/heads/b1"] }),
            bearer: w.platform.owner.clone(),
        })
    });
    commit(&c, &dir, "next", &[("n.txt", "n\n")])?;
    let out = push(
        &c,
        &dir,
        &[
            "--atomic",
            "origin",
            "HEAD:refs/heads/b1",
            "HEAD:refs/heads/b2",
        ],
    )?;
    check(
        !out.status.success(),
        &format!("atomic push must fail: {}", text(&out)),
    )?;
    let after = w.refs(&repo)?;
    check(
        after["refs/heads/b2"] == before["refs/heads/b2"],
        "b2 unchanged",
    )?;
    check(
        after["refs/heads/b1"] == moved.as_str(),
        "b1 moved only by the other writer",
    )?;
    check(
        w.proxy.count("POST", "/refs/batch") == 1,
        "one batch request",
    )
}

/// Kills a push hung at its final request `hang`. `uploads`: whether it had to upload
/// commits first (it does not when the platform already has them by their ids).
#[cfg(unix)]
fn kill_while_hung(
    w: &World,
    c: &Client,
    dir: &Path,
    args: &[&str],
    hang: &str,
    uploads: bool,
) -> TestResult {
    let commits_before = w.proxy.count("POST", "/commits");
    let hung_before = w.proxy.count("POST", hang);
    w.proxy.with(|s| s.hang = vec![hang.to_owned()]);
    let mut child = c.git_spawn(dir, args)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    while w.proxy.count("POST", hang) == hung_before {
        check(
            Instant::now() < deadline,
            "the push never reached its final step",
        )?;
        std::thread::sleep(Duration::from_millis(50));
    }
    check(
        (w.proxy.count("POST", "/commits") > commits_before) == uploads,
        if uploads {
            "commits were uploaded first"
        } else {
            "commits the platform has by id are not uploaded again"
        },
    )?;
    let group = format!("-{}", child.id());
    std::process::Command::new("kill")
        .args(["-KILL", &group])
        .status()
        .map_err(|e| e.to_string())?;
    let _ = child.wait();
    w.proxy.with(|s| s.hang.clear());
    Ok(())
}

#[cfg(unix)]
fn killed_push_leaves_refs_unchanged(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("killed", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    commit(&c, &dir, "k", &[("k.txt", "k\n")])?;
    let before = w.platform.main(&repo)?;
    kill_while_hung(
        w,
        &c,
        &dir,
        &["push", "origin", "HEAD:refs/heads/k"],
        "/branches",
        true,
    )?;
    // The killed push left k on the platform (unreferenced): pushing main reuses it.
    kill_while_hung(w, &c, &dir, &["push", "origin", "main"], "/land", false)?;
    check(w.refs(&repo)?.get("refs/heads/k").is_none(), "no branch k")?;
    check(
        w.platform.main(&repo)? == before,
        "main and the log version unchanged",
    )?;
    let retried = push(&c, &dir, &["origin", "main"])?;
    check(
        retried.status.success(),
        &format!("retry: {}", text(&retried)),
    )?;
    check(w.blob(&repo, "k.txt") == "k\n", "the retried push landed")
}

/// Tags through the helper: `git push origin v1` creates one, a fresh clone lists it, and
/// it never moves or disappears; an annotated tag keeps its object through push and clone.
fn tags_push_and_clone(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("tags", &token)?;
    let dir = w.clone(&c, &repo, "work")?;
    let first = commit(&c, &dir, "release", &[("r.txt", "r\n")])?;
    check(
        push(&c, &dir, &["origin", "main"])?.status.success(),
        "push main",
    )?;
    let main = w.refs(&repo)?["refs/heads/main"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    check(main == first, "main is the pushed commit")?;
    c.git(&dir, &["tag", "v1"])?;
    let pushed = push(&c, &dir, &["origin", "v1"])?;
    check(
        pushed.status.success(),
        &format!("push tag: {}", text(&pushed)),
    )?;
    check(
        w.refs(&repo)?["refs/tags/v1"] == first.as_str(),
        "the tag names the pushed commit",
    )?;
    let again = push(&c, &dir, &["origin", "v1"])?;
    check(
        text(&again).contains("Everything up-to-date"),
        &text(&again),
    )?;

    let other = w.client("tags-fresh", &token)?;
    let copy = w.clone(&other, &repo, "copy")?;
    check(
        other.git(&copy, &["tag", "--list"])? == "v1"
            && other.git(&copy, &["rev-parse", "v1"])? == first,
        "a fresh clone has the tag at its commit",
    )?;

    commit(&c, &dir, "later", &[("l.txt", "l\n")])?;
    c.git(&dir, &["tag", "-f", "v1"])?;
    let moved = push(&c, &dir, &["--force", "origin", "v1"])?;
    check(
        !moved.status.success() && text(&moved).contains("tags are immutable"),
        &text(&moved),
    )?;
    let deleted = push(&c, &dir, &["origin", "--delete", "v1"])?;
    check(
        !deleted.status.success() && text(&deleted).contains("cannot be deleted"),
        &text(&deleted),
    )?;
    let refs = w.refs(&repo)?;
    check(
        refs["refs/tags/v1"] == first.as_str(),
        "refusals moved nothing",
    )?;

    // An annotated tag of an unpushed commit: the helper uploads the commit, the platform
    // keeps the tag object, and a fresh clone (and a fetch) have the very same object.
    let later = c.git(&dir, &["rev-parse", "HEAD"])?;
    c.git(&dir, &["tag", "-a", "v2", "-m", "annotated"])?;
    let object = c.git(&dir, &["rev-parse", "v2"])?;
    let annotated = push(&c, &dir, &["origin", "v2"])?;
    check(annotated.status.success(), &text(&annotated))?;
    let listed = w
        .platform
        .owner_call("GET", &format!("/repos/{repo}/refs"), None)?;
    check(
        listed["refs"]["refs/tags/v2"] == later.as_str()
            && listed["annotated"]["refs/tags/v2"] == object.as_str(),
        &listed.to_string(),
    )?;
    let again = push(&c, &dir, &["origin", "v2"])?;
    check(
        text(&again).contains("Everything up-to-date"),
        &text(&again),
    )?;
    let fresh = w.client("tags-annotated", &token)?;
    let copy = w.clone(&fresh, &repo, "annotated")?;
    check(
        fresh.git(&copy, &["cat-file", "-t", "v2"])? == "tag"
            && fresh.git(&copy, &["rev-parse", "v2"])? == object
            && fresh.git(&copy, &["rev-parse", "v2^{commit}"])? == later,
        "a fresh clone has the tag object, peeled to its commit",
    )?;
    // `--atomic`: a branch and an annotated tag in one batch.
    c.git(&dir, &["checkout", "-q", "-b", "rel"])?;
    let tip = commit(&c, &dir, "rc", &[("rc.txt", "rc\n")])?;
    c.git(&dir, &["tag", "-a", "v3", "-m", "rc"])?;
    let v3 = c.git(&dir, &["rev-parse", "v3"])?;
    let atomic = push(&c, &dir, &["--atomic", "origin", "rel", "v3"])?;
    check(atomic.status.success(), &text(&atomic))?;
    let listed = w
        .platform
        .owner_call("GET", &format!("/repos/{repo}/refs"), None)?;
    check(
        listed["refs"]["refs/heads/rel"] == tip.as_str()
            && listed["annotated"]["refs/tags/v3"] == v3.as_str(),
        &listed.to_string(),
    )?;
    let fetched = fresh.git_output(&copy, &["fetch", "--tags", "origin"])?;
    check(
        fetched.status.success() && fresh.git(&copy, &["rev-parse", "v3"])? == v3,
        &text(&fetched),
    )
}

fn fresh_clone_is_byte_identical(w: &World) -> TestResult {
    let (repo, token) = w
        .platform
        .repo(&[("a.txt", "a\n"), ("bin/x.bin", "\u{1}\u{2}")])?;
    let c = w.client("fresh", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    for i in 0..3 {
        commit(
            &c,
            &dir,
            &format!("c{i}"),
            &[(&format!("dir/ünï {i}.txt"), "u\n")],
        )?;
        check(
            push(&c, &dir, &["origin", "main"])?.status.success(),
            "push",
        )?;
    }
    let other = w.client("fresh2", &token)?;
    let copy = w.clone(&other, &repo, "copy")?;
    check(
        other.git(&copy, &["rev-parse", "HEAD^{tree}"])? == w.main_tree(&repo)?,
        "fresh clone tree",
    )?;
    let fsck = other.git_output(&copy, &["fsck", "--strict"])?;
    check(fsck.status.success(), &format!("fsck: {}", text(&fsck)))?;
    let count = other.git(&copy, &["rev-list", "--count", "HEAD"])?;
    check(
        count.parse::<u32>().unwrap_or(0) >= 4,
        &format!("history fetched: {count}"),
    )?;
    // The clone holds the platform's commits themselves: the same ids as refs and log.
    let main = w.refs(&repo)?["refs/heads/main"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    check(
        other.git(&copy, &["rev-parse", "HEAD"])? == main,
        "the fresh clone's HEAD is the platform's main",
    )?;
    let log =
        w.platform
            .owner_call("GET", &format!("/repos/{repo}/log?ref=main&limit=50"), None)?;
    let logged: Vec<&str> = log["commits"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c["commit"].as_str())
        .collect();
    let listed = other.git(&copy, &["rev-list", "--first-parent", "HEAD"])?;
    let listed: Vec<&str> = listed.lines().take(logged.len()).collect();
    check(
        !logged.is_empty() && listed == logged,
        &format!("first-parent history {listed:?} is the platform's log {logged:?}"),
    )?;
    // Every pushed commit is in the platform's history under its local id.
    for pushed in c
        .git(&dir, &["rev-list", "--first-parent", "-3", "HEAD"])?
        .lines()
    {
        check(
            other
                .git_output(&copy, &["merge-base", "--is-ancestor", pushed, "HEAD"])?
                .status
                .success(),
            &format!("pushed commit {pushed} is in the fresh clone"),
        )?;
    }
    check(
        !copy.join(format!(".git/yoneda/{repo}.map")).exists()
            && !dir.join(format!(".git/yoneda/{repo}.map")).exists(),
        "no commit needed a mapped id",
    )
}

/// A commit the platform cannot rebuild exactly (here: an `encoding` header) still pushes;
/// its platform id is recorded in the commit map, the one case where ids differ.
fn unrebuildable_commit_is_mapped(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("mapped", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    write(&dir, "e.txt", "e\n")?;
    c.git(&dir, &["add", "-A"])?;
    c.git(
        &dir,
        &[
            "-c",
            "i18n.commitEncoding=ISO-8859-1",
            "commit",
            "-q",
            "-m",
            "latin",
        ],
    )?;
    let local = c.git(&dir, &["rev-parse", "HEAD"])?;
    let out = push(&c, &dir, &["origin", "HEAD:refs/heads/enc"])?;
    check(out.status.success(), &format!("push: {}", text(&out)))?;
    let server = w.refs(&repo)?["refs/heads/enc"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    check(server != local, "the platform built its own commit")?;
    check(
        w.tree_of(&repo, &server)? == c.git(&dir, &["rev-parse", "HEAD^{tree}"])?,
        "with the local tree",
    )?;
    let map = read(&dir, &format!(".git/yoneda/{repo}.map"));
    check(
        map == format!("{server} {local}\n"),
        &format!("map: {map:?}"),
    )?;
    let again = push(&c, &dir, &["origin", "HEAD:refs/heads/enc"])?;
    check(
        text(&again).contains("Everything up-to-date"),
        &text(&again),
    )?;
    // Work on top of it builds on the mapped platform commit (and is mapped too: its
    // parent's id differs, so its own does).
    let next = commit(&c, &dir, "after", &[("f.txt", "f\n")])?;
    let out = push(&c, &dir, &["origin", "HEAD:refs/heads/enc"])?;
    check(out.status.success(), &format!("push: {}", text(&out)))?;
    let head = w.refs(&repo)?["refs/heads/enc"].clone();
    check(
        head != next.as_str() && read(&dir, &format!(".git/yoneda/{repo}.map")).contains(&next),
        "the descendant is mapped",
    )?;
    check(
        w.blob_at(&repo, "enc", "f.txt") == "f\n",
        "its content landed",
    )
}

fn device_login_then_clone_with_the_stored_token(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    w.proxy.with(|s| {
        s.device_pending = 2;
        s.device_token = Some(token.clone());
    });
    let c = w.client("login", "")?;
    let out = c.ok(
        &c.home,
        &["login", "--origin", &w.proxy.origin, "--no-browser"],
    )?;
    check(out.contains("ABCD-EFGH") && out.contains("Logged in"), &out)?;
    let stored = c.home.join(".config/yoneda/credentials");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&stored)
            .map_err(|e| e.to_string())?
            .permissions()
            .mode();
        check(mode & 0o777 == 0o600, "credentials are 0600")?;
    }
    check(
        w.proxy.count("POST", "/device/token") == 3,
        "polled until approved",
    )?;
    w.clone(&c, &repo, "w")?;
    c.ok(&c.home, &["logout"])?;
    check(!stored.exists(), "logout removed the token")
}

fn import_in_batches(w: &World) -> TestResult {
    let c = w.client("import", &w.platform.owner)?;
    let src = c.home.join("src");
    std::fs::create_dir_all(&src).map_err(|e| e.to_string())?;
    c.git(&src, &["init", "-q", "-b", "main"])?;
    let files: Vec<(String, String)> = (0..7)
        .map(|i| (format!("d{}/f{i}.txt", i % 2), format!("{i}\n")))
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(p, t)| (p.as_str(), t.as_str()))
        .collect();
    commit(&c, &src, "seed", &refs)?;
    let (repos_before, commits_before) = (
        w.proxy.count("POST", "/api/v1/repos"),
        w.proxy.count("POST", "/commits"),
    );
    let out = c.ok(
        &c.home,
        &[
            "repo",
            "import",
            "src",
            "--name",
            "imp",
            "--batch-files",
            "3",
            "--origin",
            &w.proxy.origin,
        ],
    )?;
    let id = repo_id(&out)?;
    check(
        w.proxy.count("POST", "/api/v1/repos") == repos_before + 1,
        "one create",
    )?;
    check(
        w.proxy.count("POST", "/commits") == commits_before + 2,
        "two follow-up commits",
    )?;
    check(
        w.main_tree(id)? == c.git(&src, &["rev-parse", "HEAD^{tree}"])?,
        "imported tree",
    )
}

fn account_and_repository_commands(w: &World) -> TestResult {
    let c = w.client("account", &w.platform.owner)?;
    let origin = &w.proxy.origin;
    let made = c.ok(&c.home, &["repo", "create", "demo", "--origin", origin])?;
    let id = repo_id(&made)?;
    check(
        made.contains(&format!("git clone yoneda::{origin}/{id}")),
        &made,
    )?;
    let listed = c.ok(&c.home, &["repo", "list", "--origin", origin])?;
    check(listed.contains(id), &listed)?;
    let policy = c.ok(
        &c.home,
        &["policy", "show", "--repo", id, "--origin", origin],
    )?;
    check(policy.contains("\"approvals\": 0"), &policy)?;
    let minted = c.ok(
        &c.home,
        &["token", "create", "ci", "--repo", id, "--origin", origin],
    )?;
    check(minted.trim().starts_with("yrp_"), &minted)?;
    let tokens = c.ok(
        &c.home,
        &["token", "list", "--repo", id, "--origin", origin],
    )?;
    check(tokens.contains("\"ci\""), &tokens)?;
    c.ok(
        &c.home,
        &["token", "revoke", "ci", "--repo", id, "--origin", origin],
    )?;
    setup_installs_the_agent_files(&c, origin)
}

/// `yoneda setup` in a scratch HOME, with a token in the environment: the skill and
/// extension files land where each agent reads them, and no file holds the token.
fn setup_installs_the_agent_files(c: &Client, origin: &str) -> TestResult {
    let project = c.home.join("project");
    std::fs::create_dir_all(&project).map_err(|e| e.to_string())?;
    let said = c.ok(&project, &["setup", "claude", "--origin", origin])?;
    check(
        said.contains("/plugin marketplace add YonedaAI/yonedarepo")
            && said.contains("/plugin install yoneda@yoneda"),
        &said,
    )?;
    c.ok(&project, &["setup", "codex", "--origin", origin])?;
    c.ok(&project, &["setup", "gemini", "--origin", origin])?;
    let files = [
        project.join(".mcp.json"),
        c.home.join(".codex/config.toml"),
        c.home.join(".agents/skills/yoneda/SKILL.md"),
        c.home
            .join(".gemini/extensions/yoneda/gemini-extension.json"),
        c.home.join(".gemini/extensions/yoneda/GEMINI.md"),
        c.home.join(".gemini/settings.json"),
    ];
    let skill =
        std::fs::read_to_string(support::repo_root().join("plugins/codex/skills/yoneda/SKILL.md"))
            .map_err(|e| e.to_string())?;
    check(
        read(&c.home, ".agents/skills/yoneda/SKILL.md") == skill,
        "codex skill",
    )?;
    for file in files {
        let text =
            std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
        check(
            !c.token.is_empty() && !text.contains(&c.token),
            &format!("{} holds the token", file.display()),
        )?;
    }
    check(
        read(&c.home, ".gemini/extensions/yoneda/gemini-extension.json")
            .contains(&format!("{origin}/api/v1/mcp")),
        "the extension points at the origin",
    )
}

/// The sandbox team flow through the helper (see `support::team`).
fn resumed_team_merge_lands(w: &World) -> TestResult {
    let (repo, token) = w
        .platform
        .repo(&[("README.md", "# Base\n"), ("a.txt", "a\n")])?;
    let (a, b) = (w.client("team-a", &token)?, w.client("team-b", &token)?);
    support::team::resumed_merge_lands(&w.platform, &repo, &w.url(&repo), &a, &b)
}

/// `repo create --public`: anyone clones it without credentials, through the helper and
/// with stock Git; made private, both are refused; nobody writes without a token.
fn public_repositories_read_without_credentials(w: &World) -> TestResult {
    let owner = w.client("public-owner", &w.platform.owner)?;
    let origin = &w.proxy.origin;
    let made = owner.ok(
        &owner.home,
        &["repo", "create", "open", "--public", "--origin", origin],
    )?;
    check(made.starts_with("Created public open"), &made)?;
    let id = repo_id(&made)?.to_owned();
    let listed = owner.ok(&owner.home, &["repo", "list", "--origin", origin])?;
    check(listed.contains(&format!("{id}  open  public")), &listed)?;
    let seeded = owner.home.join("seed");
    owner.git(&owner.home, &["clone", "-q", &w.url(&id), "seed"])?;
    owner.commit(&seeded, "first", &[("README.md", "# open\n")])?;
    owner.git(&seeded, &["push", "-q", "origin", "HEAD:main"])?;

    // No token anywhere: an empty YONEDA_TOKEN and a fresh HOME.
    let anonymous = w.client("public-reader", "")?;
    anonymous.git(&anonymous.home, &["clone", "-q", &w.url(&id), "helper"])?;
    check(
        read(&anonymous.home, "helper/README.md") == "# open\n",
        "helper clone",
    )?;
    let stock = format!("{}/git/{id}.git", w.platform.origin);
    anonymous.git(&anonymous.home, &["clone", "-q", &stock, "stock"])?;
    check(
        read(&anonymous.home, "stock/README.md") == "# open\n",
        "stock clone",
    )?;
    let helper = anonymous.home.join("helper");
    anonymous.commit(&helper, "nope", &[("x.txt", "x\n")])?;
    let pushed = anonymous.git_output(&helper, &["push", "-q", "origin", "HEAD:main"])?;
    check(!pushed.status.success(), "an anonymous push is refused")?;

    owner.ok(
        &owner.home,
        &["repo", "visibility", &id, "private", "--origin", origin],
    )?;
    let refused = anonymous.git_output(&anonymous.home, &["clone", "-q", &w.url(&id), "late"])?;
    check(
        !refused.status.success(),
        "helper clone of a private repository",
    )?;
    let refused = anonymous.git_output(
        &anonymous.home,
        &[
            "-c",
            "credential.helper=",
            "-c",
            "core.askPass=true",
            "clone",
            "-q",
            &stock,
            "late2",
        ],
    )?;
    check(
        !refused.status.success(),
        "stock clone of a private repository",
    )?;
    Ok(())
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli -- --include-ignored"]
fn public_repositories_clone_without_credentials() -> TestResult {
    let platform = Platform::start()?;
    let proxy = Proxy::start(&platform.origin)?;
    public_repositories_read_without_credentials(&World { platform, proxy })
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli -- --include-ignored"]
fn git_works_through_the_remote_helper() -> TestResult {
    let platform = Platform::start()?;
    let proxy = Proxy::start(&platform.origin)?;
    let w = World { platform, proxy };
    clone_push_branch_and_land(&w).map_err(|e| format!("basics: {e}"))?;
    disjoint_pushes_to_main_both_land(&w).map_err(|e| format!("disjoint: {e}"))?;
    first_push_into_an_empty_repository(&w).map_err(|e| format!("empty: {e}"))?;
    same_line_overlap_conflicts_then_resolves(&w).map_err(|e| format!("overlap: {e}"))?;
    resumed_team_merge_lands(&w).map_err(|e| format!("team merge: {e}"))?;
    declared_reads_through_the_helper(&w).map_err(|e| format!("reads: {e}"))?;
    atomic_push_with_a_stale_ref_moves_nothing(&w).map_err(|e| format!("atomic: {e}"))?;
    #[cfg(unix)]
    killed_push_leaves_refs_unchanged(&w).map_err(|e| format!("killed: {e}"))?;
    fresh_clone_is_byte_identical(&w).map_err(|e| format!("fresh clone: {e}"))?;
    tags_push_and_clone(&w).map_err(|e| format!("tags: {e}"))?;
    unrebuildable_commit_is_mapped(&w).map_err(|e| format!("mapped: {e}"))?;
    device_login_then_clone_with_the_stored_token(&w).map_err(|e| format!("login: {e}"))?;
    import_in_batches(&w).map_err(|e| format!("import: {e}"))?;
    account_and_repository_commands(&w).map_err(|e| format!("account: {e}"))
}
