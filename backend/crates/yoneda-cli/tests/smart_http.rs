//! Stock `git` (no remote helper) against the local platform's smart HTTP at
//! `/git/<repo>.git`, with tokens from Git's own credential store: clone, push a branch,
//! push main (exact ids on a fast-forward, the server's merge otherwise), conflicts,
//! `--atomic` with a stale ref, lightweight and annotated tags, a push cut off mid-body, deltified
//! pushes, a fresh clone that matches the platform byte for byte, and declared reads
//! (`-o yoneda.reads=…`, `yoneda push`) refusing a stale read. Run with `cargo test
//! -p yoneda-cli --test smart_http -- --include-ignored --nocapture`; it needs the
//! workspace's node modules (wrangler) and the Rust Wasm worker build.
#[allow(dead_code)] // shared with the remote helper tests
mod support;

use base64::Engine;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
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

struct World {
    platform: Platform,
}

impl World {
    fn url(&self, repo: &str) -> String {
        format!("{}/git/{repo}.git", self.platform.origin)
    }

    /// A client whose Git finds `token` in its credential store (after the 401 asks).
    fn client(&self, name: &str, token: &str) -> TestResult<Client> {
        let home = self.platform.scratch.path().join(format!("https-{name}"));
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        let host = self.platform.origin.trim_start_matches("http://");
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

    fn clone(&self, client: &Client, repo: &str, dir: &str) -> TestResult<PathBuf> {
        let out = client.git_output(&client.home, &["clone", &self.url(repo), dir])?;
        check(out.status.success(), &format!("clone: {}", text(&out)))?;
        Ok(client.home.join(dir))
    }

    fn refs(&self, repo: &str) -> TestResult<Value> {
        Ok(self
            .platform
            .owner_call("GET", &format!("/repos/{repo}/refs"), None)?["refs"]
            .clone())
    }

    fn blob(&self, repo: &str, path: &str) -> String {
        self.platform
            .blob(repo, path)
            .map(|b| b["content"].as_str().unwrap_or_default().to_owned())
            .unwrap_or_default()
    }

    /// A raw receive-pack request: `(status, body)`.
    fn post(&self, repo: &str, token: &str, body: Vec<u8>) -> TestResult<(u16, Vec<u8>)> {
        let url = format!("{}/git-receive-pack", self.url(repo));
        let auth = base64::engine::general_purpose::STANDARD.encode(format!("git:{token}"));
        self.platform.rt.block_on(async {
            let response = reqwest::Client::new()
                .post(url)
                .header("authorization", format!("Basic {auth}"))
                .header("content-type", "application/x-git-receive-pack-request")
                .body(body)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            Ok((
                status,
                response.bytes().await.map_err(|e| e.to_string())?.to_vec(),
            ))
        })
    }
}

fn push(client: &Client, dir: &Path, args: &[&str]) -> TestResult<Output> {
    let mut all = vec!["push"];
    all.extend(args);
    client.git_output(dir, &all)
}

fn pkt(line: &str) -> Vec<u8> {
    format!("{:04x}{line}", line.len() + 4).into_bytes()
}

/// `git pack-objects` for `revs` (one per line) in `dir`.
fn pack(client: &Client, dir: &Path, revs: &str) -> TestResult<Vec<u8>> {
    let mut child = Command::new("git")
        .args([
            "pack-objects",
            "--stdout",
            "--revs",
            "-q",
            "--delta-base-offset",
        ])
        .current_dir(dir)
        .env("HOME", &client.home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .take()
        .ok_or("stdin")?
        .write_all(revs.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    check(out.status.success(), "pack-objects")?;
    Ok(out.stdout)
}

/// Delta entries in `pack`, as `git verify-pack` lists them.
fn deltas(client: &Client, pack: &[u8]) -> TestResult<usize> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    std::fs::write(dir.path().join("p.pack"), pack).map_err(|e| e.to_string())?;
    client.git(dir.path(), &["init", "-q", "."])?;
    client.git(dir.path(), &["index-pack", "p.pack"])?;
    let listed = client.git(dir.path(), &["verify-pack", "-v", "p.idx"])?;
    Ok(listed
        .lines()
        .filter(|l| l.split_whitespace().count() == 7)
        .count())
}

/// A pack whose new tree names a file neither it nor the repository holds moves nothing.
fn pack_missing_a_file_moves_nothing(w: &World) -> TestResult {
    use yoneda_core::git_object::{ObjectId, ObjectKind, write_pack};
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("missing", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    let base = c.git(&dir, &["rev-parse", "HEAD"])?;
    let tip = c.commit(&dir, "m", &[("m.txt", "never sent\n")])?;
    let read = |kind: &str, id: &str| -> TestResult<Vec<u8>> {
        let out = c.git_output(&dir, &["cat-file", kind, id])?;
        check(out.status.success(), "cat-file")?;
        Ok(out.stdout)
    };
    let (commit, tree) = (
        read("commit", &tip)?,
        read("tree", &format!("{tip}^{{tree}}"))?,
    );
    let pack = write_pack(&[(ObjectKind::Commit, &commit), (ObjectKind::Tree, &tree)])
        .map_err(|e| e.message)?;
    ObjectId::parse(&tip).map_err(|e| e.message)?;
    let mut body = pkt(&format!(
        "{} {tip} refs/heads/m\0report-status\n",
        "0".repeat(40)
    ));
    body.extend(b"0000");
    body.extend(pack);
    let before = w.platform.main(&repo)?;
    let (status, report) = w.post(&repo, &token, body)?;
    let report = String::from_utf8_lossy(&report).into_owned();
    check(
        status == 200
            && report.contains("ng refs/heads/m")
            && report.contains("missing necessary objects"),
        &report,
    )?;
    check(
        w.refs(&repo)?.get("refs/heads/m").is_none() && w.platform.main(&repo)? == before,
        "nothing moved",
    )?;
    let shown = w
        .platform
        .owner_call("GET", &format!("/repos/{repo}/commits/{tip}"), None);
    check(shown.is_err(), &format!("{base}..{tip} was not recorded"))
}

/// A pushed file holding a credential refuses the whole push by path and line, without
/// echoing it; no ref moves. The fake token is assembled at runtime.
fn pushed_secret_is_refused(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("secret", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    let fake = ["gh", "p_"].concat()
        + &"aB3dE5gH7jK9mN1pQ"
            .chars()
            .cycle()
            .take(36)
            .collect::<String>();
    c.commit(&dir, "clean", &[("ok.txt", "fine\n")])?;
    c.commit(
        &dir,
        "leak",
        &[(
            "src/env.ts",
            &format!("const a = 1;\nconst t = \"{fake}\";\n"),
        )],
    )?;
    let before = (w.refs(&repo)?, w.platform.main(&repo)?);
    for refs in [
        &["origin", "main"][..],
        &["origin", "HEAD:refs/heads/leak", "HEAD:refs/heads/other"],
    ] {
        let out = push(&c, &dir, refs)?;
        let said = text(&out);
        check(
            !out.status.success()
                && said.contains("secret detected in src/env.ts:2")
                && !said.contains(&fake),
            &said,
        )?;
    }
    check(
        (w.refs(&repo)?, w.platform.main(&repo)?) == before,
        "no ref and no log entry moved",
    )
}

fn clone_push_branch_and_main(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n"), ("f.txt", LINES)])?;
    let c = w.client("basics", &token)?;
    let dir = w.clone(&c, &repo, "work")?;
    check(
        std::fs::read_to_string(dir.join("a.txt")).unwrap_or_default() == "a\n",
        "cloned files",
    )?;
    let main = w.platform.main(&repo)?;
    check(
        c.git(&dir, &["rev-parse", "HEAD"])? == main.1,
        "the clone's HEAD is the platform's main",
    )?;
    check(
        c.git(&dir, &["rev-parse", "HEAD^{tree}"])? == main.2,
        "clone tree",
    )?;

    c.git(&dir, &["checkout", "-q", "-b", "feature"])?;
    let local = c.commit(&dir, "add b", &[("b.txt", "b\n")])?;
    let out = push(&c, &dir, &["origin", "feature"])?;
    check(
        out.status.success(),
        &format!("push branch: {}", text(&out)),
    )?;
    check(
        w.refs(&repo)?["refs/heads/feature"] == local.as_str(),
        "the branch is the pushed commit",
    )?;
    let again = push(&c, &dir, &["origin", "feature"])?;
    check(
        text(&again).contains("Everything up-to-date"),
        &text(&again),
    )?;
    // A forced rewrite of a working branch is a compare-and-swap on what Git saw.
    c.git(&dir, &["reset", "-q", "--hard", "HEAD~1"])?;
    let rewritten = c.commit(&dir, "add c", &[("c.txt", "c\n")])?;
    check(
        !push(&c, &dir, &["origin", "feature"])?.status.success(),
        "non-fast-forward refused",
    )?;
    let forced = push(&c, &dir, &["--force", "origin", "feature"])?;
    check(
        forced.status.success(),
        &format!("force: {}", text(&forced)),
    )?;
    check(
        w.refs(&repo)?["refs/heads/feature"] == rewritten.as_str(),
        "forced head",
    )?;

    c.git(&dir, &["checkout", "-q", "main"])?;
    let pushed = c.commit(&dir, "add d", &[("d.txt", "dee\n")])?;
    let landed = push(&c, &dir, &["origin", "main"])?;
    check(
        landed.status.success(),
        &format!("push main: {}", text(&landed)),
    )?;
    check(
        w.refs(&repo)?["refs/heads/main"] == pushed.as_str(),
        "main is exactly the pushed commit",
    )?;
    check(w.blob(&repo, "d.txt") == "dee\n", "landed content")?;
    // A forced push to main lands like any other (here with a server merge): main's
    // history is never rewritten. main is never deleted; a branch is.
    c.git(&dir, &["reset", "-q", "--hard", "HEAD~1"])?;
    let rewrite = c.commit(&dir, "rewrite", &[("e.txt", "e\n")])?;
    let forced = push(&c, &dir, &["--force", "origin", "main"])?;
    check(
        forced.status.success() && text(&forced).contains("landed with server merge"),
        &text(&forced),
    )?;
    check(
        w.blob(&repo, "d.txt") == "dee\n" && w.blob(&repo, "e.txt") == "e\n",
        "main kept d.txt",
    )?;
    let merged = w.refs(&repo)?["refs/heads/main"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    check(
        merged != rewrite && merged != pushed,
        "main is the server's merge",
    )?;
    let deleted = push(&c, &dir, &["origin", "--delete", "main"])?;
    check(!deleted.status.success(), &text(&deleted))?;
    let gone = push(&c, &dir, &["origin", "--delete", "feature"])?;
    check(
        gone.status.success(),
        &format!("delete branch: {}", text(&gone)),
    )?;
    check(
        w.refs(&repo)?.get("refs/heads/feature").is_none(),
        "feature deleted",
    )?;
    check(
        w.refs(&repo)?["refs/heads/main"] == merged.as_str(),
        "refusals moved nothing",
    )
}

/// Change requests from the command line: a pushed branch suggests one, `yoneda change`
/// opens, shows, comments on and lands it, and landing marks it landed.
fn change_requests(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let mut c = w.client("changes", &token)?;
    let dir = w.clone(&c, &repo, "work")?;
    c.token = token;
    c.git(&dir, &["checkout", "-q", "-b", "feature"])?;
    let head = c.commit(&dir, "Add b", &[("b.txt", "b\n")])?;
    let out = push(&c, &dir, &["origin", "feature"])?;
    check(
        out.status.success() && text(&out).contains("open a change: yoneda change create feature"),
        &text(&out),
    )?;
    let opened = c.ok(&dir, &["change", "create"])?;
    check(
        opened.contains("#1 [open] Add b (feature -> main)"),
        &opened,
    )?;
    check(
        c.ok(&dir, &["change", "list"])?.contains("#1 [open]"),
        "listed",
    )?;
    let said = c.ok(
        &dir,
        &[
            "change", "comment", "1", "-m", "Why b?", "--path", "b.txt", "--line", "1", "--side",
            "new",
        ],
    )?;
    check(said.contains("Commented on change #1"), &said)?;
    let shown = c.ok(&dir, &["change", "show", "1"])?;
    check(
        shown.contains(&format!("head {head}"))
            && shown.contains("ready to land")
            && shown.contains("add b.txt")
            && shown.contains("on b.txt:1 (new)"),
        &shown,
    )?;
    let landed = c.ok(&dir, &["change", "land", "1"])?;
    check(landed.contains("Landed change #1"), &landed)?;
    let change = w
        .platform
        .owner_call("GET", &format!("/repos/{repo}/changes/1"), None)?;
    check(
        change["status"] == "landed" && change["landed_commit"] == head.as_str(),
        &change.to_string(),
    )?;
    let again = c.yoneda(&dir, &["change", "land", "1"])?;
    check(
        !again.status.success(),
        "a landed change does not land again",
    )
}

/// Tags: `git push origin v1` creates one, a fresh clone has it, and it never moves or
/// disappears; an annotated tag keeps its object through push and clone, and a malformed
/// one is refused.
fn tags_push_and_clone(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("tags", &token)?;
    let dir = w.clone(&c, &repo, "work")?;
    let first = c.commit(&dir, "release", &[("r.txt", "r\n")])?;
    check(
        push(&c, &dir, &["origin", "main"])?.status.success(),
        "push main",
    )?;
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
        other.git(&copy, &["tag", "--list"])? == "v1",
        "a fresh clone lists the tag",
    )?;
    check(
        other.git(&copy, &["rev-parse", "v1"])? == first,
        "the cloned tag names the commit",
    )?;

    // Moving or deleting it is refused; the tag stays where it was.
    c.commit(&dir, "later", &[("l.txt", "l\n")])?;
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

    // An annotated tag of an unpushed commit: the push records the commit, keeps the tag
    // object, and a fresh clone has the very same object, peeled to that commit.
    let later = c.git(&dir, &["rev-parse", "HEAD"])?;
    c.git(&dir, &["tag", "-a", "v2", "-m", "annotated"])?;
    let annotated = push(&c, &dir, &["origin", "v2"])?;
    check(annotated.status.success(), &text(&annotated))?;
    let object = c.git(&dir, &["rev-parse", "v2"])?;
    let listed = w
        .platform
        .owner_call("GET", &format!("/repos/{repo}/refs"), None)?;
    check(
        listed["refs"]["refs/tags/v2"] == later.as_str()
            && listed["annotated"]["refs/tags/v2"] == object.as_str(),
        &listed.to_string(),
    )?;
    let fresh = w.client("tags-annotated", &token)?;
    let copy = w.clone(&fresh, &repo, "annotated")?;
    check(
        fresh.git(&copy, &["cat-file", "-t", "v2"])? == "tag",
        "a fresh clone has the tag object",
    )?;
    check(
        fresh.git(&copy, &["rev-parse", "v2"])? == object
            && fresh.git(&copy, &["rev-parse", "v2^{commit}"])? == later,
        "the cloned tag is the pushed object, peeled to its commit",
    )?;

    // A malformed tag object (Git parses it, but its tagger line is no identity) is
    // refused and moves nothing.
    let bad = format!("object {later}\ntype commit\ntag v3\ntagger nobody\n\nm\n");
    std::fs::write(dir.join("bad-tag"), bad).map_err(|e| e.to_string())?;
    let id = c.git(
        &dir,
        &["hash-object", "-t", "tag", "-w", "--literally", "bad-tag"],
    )?;
    c.git(&dir, &["update-ref", "refs/tags/v3", &id])?;
    let malformed = push(&c, &dir, &["origin", "v3"])?;
    check(
        !malformed.status.success() && text(&malformed).contains("invalid tag object"),
        &text(&malformed),
    )?;
    check(
        w.refs(&repo)?.get("refs/tags/v3").is_none(),
        "a malformed tag moved nothing",
    )
}

fn disjoint_pushes_to_main_both_land(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let (c1, c2) = (w.client("d1", &token)?, w.client("d2", &token)?);
    let (d1, d2) = (w.clone(&c1, &repo, "w")?, w.clone(&c2, &repo, "w")?);
    let x = c1.commit(&d1, "x", &[("x.txt", "x\n")])?;
    let y = c2.commit(&d2, "y", &[("y.txt", "y\n")])?;
    check(
        push(&c1, &d1, &["origin", "main"])?.status.success(),
        "first lands",
    )?;
    let second = push(&c2, &d2, &["--progress", "origin", "main"])?;
    check(
        second.status.success() && text(&second).contains("landed with server merge, run git pull"),
        &format!("second push: {}", text(&second)),
    )?;
    // Main's recent heads are listed as `.have`: the stale clone sends only its own commit,
    // root tree and file.
    check(
        text(&second).contains("Writing objects: 100% (3/3)"),
        &text(&second),
    )?;
    check(
        w.blob(&repo, "x.txt") == "x\n" && w.blob(&repo, "y.txt") == "y\n",
        "both landed",
    )?;
    let main = w.refs(&repo)?["refs/heads/main"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    // Pushing a head main already holds lands nothing.
    let again = push(&c1, &d1, &["origin", "main"])?;
    check(
        again.status.success(),
        &format!("push held head: {}", text(&again)),
    )?;
    check(
        w.refs(&repo)?["refs/heads/main"] == main.as_str(),
        "main unchanged",
    )?;
    for (c, d, pushed) in [(&c1, &d1, &x), (&c2, &d2, &y)] {
        let pulled = c.git_output(d, &["pull", "-q", "--ff-only", "origin", "main"])?;
        check(pulled.status.success(), &format!("pull: {}", text(&pulled)))?;
        check(c.git(d, &["rev-parse", "HEAD"])? == main, "pulled to main")?;
        let ancestor = c.git_output(d, &["merge-base", "--is-ancestor", pushed, &main])?;
        check(
            ancestor.status.success(),
            "the pushed commit is in main's history by its own id",
        )?;
    }
    Ok(())
}

fn same_line_conflicts_then_resolves(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("f.txt", LINES)])?;
    let (c1, c2) = (w.client("o1", &token)?, w.client("o2", &token)?);
    let (d1, d2) = (w.clone(&c1, &repo, "w")?, w.clone(&c2, &repo, "w")?);
    c1.commit(&d1, "ours", &[("f.txt", &LINES.replace("l4", "one"))])?;
    c2.commit(&d2, "theirs", &[("f.txt", &LINES.replace("l4", "two"))])?;
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
    let _ = c2.git_output(&d2, &["pull", "-q", "--no-rebase", "origin", "main"])?;
    std::fs::write(d2.join("f.txt"), LINES.replace("l4", "both")).map_err(|e| e.to_string())?;
    c2.git(&d2, &["commit", "-q", "-am", "resolve"])?;
    let resolved = push(&c2, &d2, &["origin", "main"])?;
    check(
        resolved.status.success(),
        &format!("resolved: {}", text(&resolved)),
    )?;
    check(
        w.blob(&repo, "f.txt") == LINES.replace("l4", "both"),
        "resolution landed",
    )
}

/// Declared reads (C1): clone A relies on config.json and edits app.js while clone B edits
/// config.json and lands first. A's push declaring the read is refused as a read conflict,
/// and stays refused without the option (the reads are the commit's). After `git pull`,
/// `yoneda push` declares the session's recorded reads, lands and clears them, and the
/// pushed commit takes a session record. The same work without a declaration lands by
/// server merge.
fn declared_reads_refuse_a_stale_read(w: &World) -> TestResult {
    let files = [("config.json", "{\"v\":1}\n"), ("app.js", "a\n")];
    for declare in [true, false] {
        let (repo, token) = w.platform.repo(&files)?;
        let mut a = w.client(&format!("reads-a-{declare}"), &token)?;
        a.token = token.clone();
        let b = w.client(&format!("reads-b-{declare}"), &token)?;
        let (da, db) = (w.clone(&a, &repo, "w")?, w.clone(&b, &repo, "w")?);
        let mine = a.commit(&da, "app", &[("app.js", "a2\n")])?;
        b.commit(&db, "config", &[("config.json", "{\"v\":2}\n")])?;
        check(
            push(&b, &db, &["origin", "main"])?.status.success(),
            "B lands first",
        )?;
        let theirs = w.platform.main(&repo)?.1;
        if !declare {
            let landed = push(&a, &da, &["origin", "main"])?;
            check(
                landed.status.success() && text(&landed).contains("landed with server merge"),
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
        check(w.platform.main(&repo)?.1 == theirs, "main kept B's")?;
        let shown = w
            .platform
            .owner_call("GET", &format!("/repos/{repo}/commits/{mine}"), None)?;
        check(
            shown["read_set"] == json!(["config.json"]),
            &shown["read_set"].to_string(),
        )?;
        let again = push(&a, &da, &["origin", "main"])?;
        check(
            !again.status.success() && text(&again).contains("read conflict on config.json"),
            &format!("undeclared retry: {}", text(&again)),
        )?;
        // The session's recorded reads, declared by `yoneda push` after a pull.
        a.ok(&da, &["reads", "add", "config.json"])?;
        let pulled = a.git_output(&da, &["pull", "-q", "--no-rebase", "origin", "main"])?;
        check(pulled.status.success(), &format!("pull: {}", text(&pulled)))?;
        let merged = a.git(&da, &["rev-parse", "HEAD"])?;
        let out = a.yoneda(&da, &["push", "origin", "main"])?;
        check(
            out.status.success(),
            &format!("yoneda push: {}", text(&out)),
        )?;
        check(w.platform.main(&repo)?.1 == merged, "the merge landed")?;
        check(
            a.ok(&da, &["reads", "list"])?.trim().is_empty(),
            "reads cleared",
        )?;
        let pushed = std::fs::read_to_string(da.join(".git/yoneda/pushed")).unwrap_or_default();
        check(pushed.starts_with(&merged), &format!("pushed: {pushed}"))?;
        a.ok(
            &da,
            &[
                "session",
                "record",
                "--cli",
                "claude-code",
                "--summary",
                "Merged config v2 under app.js",
            ],
        )?;
        let listed = a.ok(&da, &["session", "list"])?;
        check(
            listed.contains("claude-code") && listed.contains("Merged config v2"),
            &listed,
        )?;
    }
    Ok(())
}

/// `--atomic` through Git, then a request whose b1 expectation went stale after Git
/// listed the refs: the server moves neither branch.
fn atomic_push_with_a_stale_ref_moves_nothing(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("atomic", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    c.commit(&dir, "start", &[("s.txt", "s\n")])?;
    let made = push(
        &c,
        &dir,
        &[
            "--atomic",
            "origin",
            "HEAD:refs/heads/b1",
            "HEAD:refs/heads/b2",
        ],
    )?;
    check(made.status.success(), &text(&made))?;
    let before = w.refs(&repo)?;
    let start = c.git(&dir, &["rev-parse", "HEAD"])?;
    let main = w.platform.main(&repo)?.1;
    w.platform.owner_call(
        "POST",
        &format!("/repos/{repo}/branches"),
        Some(json!({ "ref": "refs/heads/b1", "commit": main, "expected": start })),
    )?;
    let next = c.commit(&dir, "next", &[("n.txt", "n\n")])?;
    let mut body = pkt(&format!(
        "{start} {next} refs/heads/b1\0report-status atomic\n"
    ));
    body.extend(pkt(&format!("{start} {next} refs/heads/b2\n")));
    body.extend(b"0000");
    body.extend(pack(&c, &dir, &format!("{next}\n^{start}\n"))?);
    let (status, report) = w.post(&repo, &token, body)?;
    let report = String::from_utf8_lossy(&report).into_owned();
    check(
        status == 200
            && report.contains("ng refs/heads/b1 fetch first")
            && report.contains("ng refs/heads/b2 atomic push refused"),
        &format!("atomic report {status}: {report}"),
    )?;
    let after = w.refs(&repo)?;
    check(
        after["refs/heads/b2"] == before["refs/heads/b2"],
        "b2 unchanged",
    )?;
    check(
        after["refs/heads/b1"] == main.as_str(),
        "b1 moved only by the other writer",
    )
}

/// A push cut off mid-pack (the connection dropped, or a body that ends early) moves no
/// ref and adds no log entry; the retried push lands.
fn cut_off_push_moves_nothing(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[("a.txt", "a\n")])?;
    let c = w.client("killed", &token)?;
    let dir = w.clone(&c, &repo, "w")?;
    let base = c.git(&dir, &["rev-parse", "HEAD"])?;
    let big: String = (0..20_000)
        .map(|i| format!("line {i} {}\n", i * 7919 % 10007))
        .collect();
    let tip = c.commit(&dir, "k", &[("k.txt", &big)])?;
    let before = w.platform.main(&repo)?;
    let mut body = pkt(&format!("{base} {tip} refs/heads/main\0report-status\n"));
    body.extend(b"0000");
    let full = pack(&c, &dir, &format!("{tip}\n^{base}\n"))?;
    body.extend(&full[..full.len() / 2]);
    // The connection drops before the declared length arrives.
    let host = w.platform.origin.trim_start_matches("http://").to_owned();
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("git:{token}"));
    let mut stream = std::net::TcpStream::connect(&host).map_err(|e| e.to_string())?;
    write!(
        stream,
        "POST /git/{repo}.git/git-receive-pack HTTP/1.1\r\nHost: {host}\r\nAuthorization: Basic {auth}\r\n\
         Content-Type: application/x-git-receive-pack-request\r\nContent-Length: {}\r\n\r\n",
        body.len() + full.len()
    )
    .map_err(|e| e.to_string())?;
    stream.write_all(&body).map_err(|e| e.to_string())?;
    drop(stream);
    // A complete request whose pack ends early: the report says so.
    let (status, report) = w.post(&repo, &token, body)?;
    let report = String::from_utf8_lossy(&report).into_owned();
    check(
        status == 200 && report.contains("unpack ") && report.contains("ng refs/heads/main"),
        &report,
    )?;
    std::thread::sleep(Duration::from_millis(500));
    check(
        w.platform.main(&repo)? == before,
        "main and the log version unchanged",
    )?;
    let retried = push(&c, &dir, &["origin", "main"])?;
    check(
        retried.status.success(),
        &format!("retry: {}", text(&retried)),
    )?;
    check(
        w.refs(&repo)?["refs/heads/main"] == tip.as_str(),
        "the retried push landed exactly",
    )
}

/// 100 files pushed into an empty repository, then three edits of one large file pushed
/// together (Git deltifies them), then a fresh clone: same ids, fsck clean, same log.
fn hundred_files_push_and_fresh_clone(w: &World) -> TestResult {
    let (repo, token) = w.platform.repo(&[])?;
    let c = w.client("hundred", &token)?;
    let dir = c.home.join("local");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    c.git(&dir, &["init", "-q", "-b", "main", "."])?;
    c.git(&dir, &["remote", "add", "origin", &w.url(&repo)])?;
    let files: Vec<(String, String)> = (0..100)
        .map(|i| {
            (
                format!("src/m{}/f{i}.txt", i % 10),
                format!("file {i}\n{}", "x".repeat(i * 13)),
            )
        })
        .collect();
    let refs: Vec<(&str, &str)> = files
        .iter()
        .map(|(p, t)| (p.as_str(), t.as_str()))
        .collect();
    c.commit(&dir, "hundred files", &refs)?;
    let started = Instant::now();
    let out = push(&c, &dir, &["-u", "origin", "main"])?;
    let push_ms = started.elapsed().as_millis();
    check(out.status.success(), &format!("first push: {}", text(&out)))?;
    let big: String = (0..3000)
        .map(|i| format!("{i}: some text that repeats\n"))
        .collect();
    let before = c.git(&dir, &["rev-parse", "HEAD"])?;
    for round in 0..3 {
        c.commit(
            &dir,
            &format!("edit {round}"),
            &[("big.txt", &big.replace(&format!("{round}0:"), "edited:"))],
        )?;
    }
    // The pack Git builds for this push (ofs-delta, no thin bases) holds deltas.
    let sent = pack(&c, &dir, &format!("HEAD\n^{before}\n"))?;
    check(
        deltas(&c, &sent)? >= 1,
        "the push carries deltified objects",
    )?;
    let out = push(&c, &dir, &["origin", "main"])?;
    check(out.status.success(), &format!("delta push: {}", text(&out)))?;
    check(
        w.blob(&repo, "big.txt") == big.replace("20:", "edited:"),
        "deltified content",
    )?;
    // Past http.postBuffer (1 MiB), Git probes first and then streams the body chunked.
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    let noise: Vec<u8> = (0..3 << 20)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect();
    std::fs::write(dir.join("noise.bin"), &noise).map_err(|e| e.to_string())?;
    c.git(&dir, &["add", "noise.bin"])?;
    c.git(&dir, &["commit", "-q", "-m", "noise"])?;
    let out = push(&c, &dir, &["origin", "main"])?;
    check(out.status.success(), &format!("large push: {}", text(&out)))?;
    let head = c.git(&dir, &["rev-parse", "HEAD"])?;
    check(
        w.refs(&repo)?["refs/heads/main"] == head.as_str(),
        "main is the local head",
    )?;

    let other = w.client("hundred-fresh", &token)?;
    let started = Instant::now();
    let copy = w.clone(&other, &repo, "copy")?;
    let clone_ms = started.elapsed().as_millis();
    eprintln!("100-file repository: push {push_ms} ms, fresh clone {clone_ms} ms");
    check(
        other.git(&copy, &["rev-parse", "HEAD"])? == head,
        "fresh clone HEAD",
    )?;
    check(
        std::fs::read(copy.join("noise.bin")).unwrap_or_default() == noise,
        "large file cloned",
    )?;
    let fsck = other.git_output(&copy, &["fsck", "--strict"])?;
    check(fsck.status.success(), &format!("fsck: {}", text(&fsck)))?;
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
    check(
        listed.lines().collect::<Vec<_>>() == logged,
        "first-parent history is the platform's log",
    )?;
    // An incremental fetch after one more push brings only what is new.
    c.commit(&dir, "one more", &[("z.txt", "z\n")])?;
    check(
        push(&c, &dir, &["origin", "main"])?.status.success(),
        "push z",
    )?;
    let fetched = other.git_output(&copy, &["pull", "-q", "--ff-only"])?;
    check(
        fetched.status.success(),
        &format!("pull: {}", text(&fetched)),
    )?;
    check(
        std::fs::read_to_string(copy.join("z.txt")).unwrap_or_default() == "z\n",
        "pulled z",
    )
}

/// The sandbox team flow with stock Git (see `support::team`).
fn resumed_team_merge_lands(w: &World) -> TestResult {
    let (repo, token) = w
        .platform
        .repo(&[("README.md", "# Base\n"), ("a.txt", "a\n")])?;
    let (a, b) = (w.client("team-a", &token)?, w.client("team-b", &token)?);
    support::team::resumed_merge_lands(&w.platform, &repo, &w.url(&repo), &a, &b)
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli --test smart_http -- --include-ignored"]
fn stock_git_over_https() -> TestResult {
    let w = World {
        platform: Platform::start()?,
    };
    clone_push_branch_and_main(&w).map_err(|e| format!("basics: {e}"))?;
    tags_push_and_clone(&w).map_err(|e| format!("tags: {e}"))?;
    disjoint_pushes_to_main_both_land(&w).map_err(|e| format!("disjoint: {e}"))?;
    same_line_conflicts_then_resolves(&w).map_err(|e| format!("overlap: {e}"))?;
    resumed_team_merge_lands(&w).map_err(|e| format!("team merge: {e}"))?;
    declared_reads_refuse_a_stale_read(&w).map_err(|e| format!("reads: {e}"))?;
    atomic_push_with_a_stale_ref_moves_nothing(&w).map_err(|e| format!("atomic: {e}"))?;
    cut_off_push_moves_nothing(&w).map_err(|e| format!("cut off: {e}"))?;
    pack_missing_a_file_moves_nothing(&w).map_err(|e| format!("missing: {e}"))?;
    pushed_secret_is_refused(&w).map_err(|e| format!("secret: {e}"))?;
    hundred_files_push_and_fresh_clone(&w).map_err(|e| format!("hundred: {e}"))?;
    change_requests(&w).map_err(|e| format!("changes: {e}"))
}
