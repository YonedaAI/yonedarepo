//! A clone against real Git: what is fetched and how, what comes out, and what is refused.
//! The remote is a local one (`file://`), allowed only by the test door `clone_with`; the
//! checks in front of that door have their own tests below.
use crate::check_runner::hand_over;
use crate::clone_git::{Credential, clone_failed};
use crate::clone_history::commit_lines;
use crate::clone_import::{CloneRequest, Cloned, clone_remote, clone_with, routes_holding};
use crate::clone_read::frames_body;
use crate::clone_remote::{check_url, refused_address};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use yoneda_core::git_object::{Commit, ObjectId, ObjectKind, hash_object};

const GIB: u64 = 1024 * 1024 * 1024;

fn git(dir: &Path, args: &[&str]) -> Output {
    // In the image build these run as root, on a remote handed to the UID the clone runs as.
    Command::new("git")
        .current_dir(dir)
        .args(["-c", "safe.directory=*"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "A")
        .env("GIT_AUTHOR_EMAIL", "a@example.com")
        .env("GIT_COMMITTER_NAME", "A")
        .env("GIT_COMMITTER_EMAIL", "a@example.com")
        .env("GIT_AUTHOR_DATE", "1700000000 +0000")
        .env("GIT_COMMITTER_DATE", "1700000000 +0000")
        .output()
        .unwrap()
}

fn ok(dir: &Path, args: &[&str]) -> String {
    let out = git(dir, args);
    let said = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "git {args:?}: {said}");
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

fn write(dir: &Path, path: &str, content: &str) {
    let path = dir.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

/// A repository with one of everything a commit can change, several branches and tags: `tips`
/// are its commits, oldest first, along main's first parents.
struct Remote {
    _dir: tempfile::TempDir,
    path: PathBuf,
    tips: Vec<String>,
    side: String,
    other: String,
    pull: String,
}

impl Remote {
    fn url(&self) -> String {
        format!("file://{}", self.path.display())
    }
}

fn remote() -> Remote {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("src");
    std::fs::create_dir(&path).unwrap();
    let p = path.as_path();
    ok(p, &["init", "-q", "-b", "main"]);
    let commit = |message: &str| {
        ok(p, &["add", "-A"]);
        ok(p, &["commit", "-q", "-m", message]);
        ok(p, &["rev-parse", "HEAD"])
    };
    write(p, "a.txt", "one\n");
    write(p, "dir/b.txt", "same\n");
    write(p, "run.sh", "#!/bin/sh\n");
    std::fs::set_permissions(p.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("a.txt", p.join("link")).unwrap();
    let mut tips = vec![commit("root")];
    write(p, "a.txt", "two\n");
    std::fs::set_permissions(p.join("run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
    tips.push(commit("modify and chmod"));
    ok(p, &["checkout", "-q", "-b", "side"]);
    write(p, "side.txt", "side\n");
    let side = commit("on the side");
    ok(p, &["tag", "-a", "v1", "-m", "a tag", &side]);
    ok(p, &["checkout", "-q", "main"]);
    ok(p, &["mv", "dir/b.txt", "dir/c.txt"]);
    tips.push(commit("rename"));
    ok(p, &["merge", "-q", "--no-ff", "-m", "merge side", "side"]);
    tips.push(ok(p, &["rev-parse", "HEAD"]));
    std::fs::remove_file(p.join("link")).unwrap();
    ok(p, &["add", "-A"]);
    let nested = "160000,1111111111111111111111111111111111111111,vendor/mod";
    ok(p, &["update-index", "--add", "--cacheinfo", nested]);
    ok(p, &["commit", "-q", "-m", "drop a link, add a submodule"]);
    tips.push(ok(p, &["rev-parse", "HEAD"]));
    ok(p, &["checkout", "-q", "-b", "other"]);
    write(p, "other.txt", "other\n");
    let other = commit("not on main");
    ok(p, &["checkout", "-q", "main"]);
    ok(p, &["tag", "light", &tips[1]]);
    let blob = ok(p, &["rev-parse", "main:a.txt"]);
    ok(p, &["tag", "-a", "a-file", "-m", "not a commit", &blob]);
    // What a remote keeps beside its branches, as a pull request's head.
    let tree = ok(p, &["rev-parse", "main^{tree}"]);
    let pull = ok(
        p,
        &["commit-tree", &tree, "-p", &other, "-m", "a pull request"],
    );
    ok(p, &["update-ref", "refs/pull/1/head", &pull]);
    hand_over(dir.path()).unwrap();
    Remote {
        _dir: dir,
        path,
        tips,
        side,
        other,
        pull,
    }
}

fn asked(url: String) -> CloneRequest {
    CloneRequest {
        url,
        max_pack_bytes: GIB,
        timeout_seconds: 60,
    }
}

async fn cloned_at(url: String) -> (Cloned, Value) {
    let none = Credential::default();
    clone_with(asked(url), "file", &none).await.unwrap()
}

async fn cloned(remote: &Remote) -> (Cloned, Value) {
    cloned_at(remote.url()).await
}

/// Every commit as the Worker reads it.
async fn history(cloned: &Cloned) -> Vec<Value> {
    commit_lines(cloned.repo(), cloned.commits())
        .await
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn by_id<'a>(lines: &'a [Value], id: &str) -> &'a Value {
    lines.iter().find(|c| c["commit"] == id).unwrap()
}

/// A repository of its own, with what `build` makes in it.
fn built(build: impl FnOnce(&Path, &Path)) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("src");
    std::fs::create_dir(&path).unwrap();
    ok(&path, &["init", "-q", "-b", "main"]);
    build(&path, dir.path());
    hand_over(dir.path()).unwrap();
    let url = format!("file://{}", path.display());
    (dir, url)
}

#[tokio::test]
async fn the_clone_is_bare_has_no_hooks_and_holds_every_branch_and_tag() {
    let remote = remote();
    let (clone, summary) = cloned(&remote).await;
    let repo = clone.repo();
    assert!(!repo.join("hooks").exists(), "a template brought hooks");
    assert_eq!(ok(repo, &["rev-parse", "--is-bare-repository"]), "true");
    assert!(!repo.join("a.txt").exists());
    assert_eq!(summary["default_branch"], "main");
    ok(repo, &["cat-file", "-e", &remote.side]);
    ok(repo, &["cat-file", "-e", &remote.other]);
    let list = |prefix: &str| ok(repo, &["for-each-ref", "--format=%(refname:short)", prefix]);
    assert_eq!(
        list("refs/heads").lines().collect::<Vec<_>>(),
        ["main", "other", "side"]
    );
    assert_eq!(
        list("refs/tags").lines().collect::<Vec<_>>(),
        ["a-file", "light", "v1"]
    );
    // What a remote keeps beside its branches stays there.
    assert_eq!(ok(repo, &["for-each-ref", "refs/pull"]), "");
    assert!(
        !git(repo, &["cat-file", "-e", &remote.pull])
            .status
            .success()
    );
}

#[tokio::test]
async fn the_pack_is_everything_as_a_client_is_sent_it() {
    let remote = remote();
    let (clone, summary) = cloned(&remote).await;
    let bytes = std::fs::read(clone.pack()).unwrap();
    assert_eq!(&bytes[..4], b"PACK");
    assert_eq!(summary["pack_bytes"], bytes.len());
    let held = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
    assert_eq!(summary["pack_objects"], held);
    let idx = clone.pack().with_extension("idx");
    ok(clone.repo(), &["verify-pack", idx.to_str().unwrap()]);
    let listed = ok(clone.repo(), &["rev-list", "--objects", "--all"]);
    assert_eq!(held as usize, listed.lines().count());
    // All of them but the tag objects, which stay with their refs.
    assert_eq!(summary["objects"].as_u64(), Some(u64::from(held) - 2));
}

#[tokio::test]
async fn every_commit_of_every_branch_comes_out_parents_first() {
    let remote = remote();
    let (clone, summary) = cloned(&remote).await;
    let lines = history(&clone).await;
    let all = ok(&remote.path, &["rev-list", "--all"]);
    assert_eq!(summary["commits"].as_u64(), Some(lines.len() as u64));
    let mut listed: Vec<_> = lines
        .iter()
        .map(|c| c["commit"].as_str().unwrap())
        .collect();
    let mut expected: Vec<_> = all.lines().filter(|id| *id != remote.pull).collect();
    listed.sort_unstable();
    expected.sort_unstable();
    assert_eq!(listed, expected);
    // A diverged branch's commits are all here, and every parent comes first.
    assert!(listed.contains(&remote.other.as_str()));
    let mut seen = std::collections::HashSet::new();
    for line in &lines {
        let id = line["commit"].as_str().unwrap();
        let data = STANDARD.decode(line["data_b64"].as_str().unwrap()).unwrap();
        assert_eq!(hash_object(ObjectKind::Commit, &data).hex(), id);
        for parent in Commit::decode(&data).unwrap().parents().unwrap() {
            assert!(seen.contains(&parent.hex()), "{id} before its parent");
        }
        seen.insert(id.to_owned());
        assert_eq!(line["objects"], json!([{ "id": id, "kind": "commit" }]));
        assert_eq!(line["check"], false);
    }
}

#[tokio::test]
async fn each_commit_lists_its_changes_against_its_first_parent() {
    let remote = remote();
    let (clone, _) = cloned(&remote).await;
    let lines = history(&clone).await;
    let blob = |rev: &str| ok(&remote.path, &["rev-parse", rev]);
    let at = |n: usize| by_id(&lines, &remote.tips[n]);
    let (root, modify, rename, merge, submodule) = (at(0), at(1), at(2), at(3), at(4));
    assert_eq!(
        root["touches"],
        json!([
            {"path": "a.txt", "op": "add", "old_blob": null, "new_blob": blob("main~4:a.txt"), "mode": "blob"},
            {"path": "dir/b.txt", "op": "add", "old_blob": null, "new_blob": blob("main~4:dir/b.txt"), "mode": "blob"},
            {"path": "link", "op": "add", "old_blob": null, "new_blob": blob("main~4:link"), "mode": "symlink"},
            {"path": "run.sh", "op": "add", "old_blob": null, "new_blob": blob("main~4:run.sh"), "mode": "exec"},
        ])
    );
    let run_sh = blob("main~4:run.sh");
    assert_eq!(
        modify["touches"],
        json!([
            {"path": "a.txt", "op": "modify", "old_blob": blob("main~4:a.txt"), "new_blob": blob("main~3:a.txt"), "mode": "blob"},
            {"path": "run.sh", "op": "modify", "old_blob": run_sh, "new_blob": run_sh, "mode": "blob"},
        ])
    );
    // A rename is its delete and its add.
    let same = blob("main~4:dir/b.txt");
    assert_eq!(
        rename["touches"],
        json!([
            {"path": "dir/b.txt", "op": "delete", "old_blob": same, "new_blob": null},
            {"path": "dir/c.txt", "op": "add", "old_blob": null, "new_blob": same, "mode": "blob"},
        ])
    );
    // A merge changes what its first parent lacked.
    assert_eq!(
        merge["touches"],
        json!([
            {"path": "side.txt", "op": "add", "old_blob": null, "new_blob": blob("main~1:side.txt"), "mode": "blob"},
        ])
    );
    // A nested repository's commit is a touch with no mode, as in `touch`.
    assert_eq!(
        submodule["touches"],
        json!([
            {"path": "link", "op": "delete", "old_blob": blob("main~4:link"), "new_blob": null},
            {"path": "vendor/mod", "op": "add", "old_blob": null, "new_blob": "1111111111111111111111111111111111111111"},
        ])
    );
    // A side branch's commit is diffed against where it left.
    let side = by_id(&lines, &remote.side);
    assert_eq!(side["touches"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_slice_of_commits_reads_the_same_as_the_whole() {
    let remote = remote();
    let (clone, _) = cloned(&remote).await;
    let whole = commit_lines(clone.repo(), clone.commits()).await.unwrap();
    let mut parts = String::new();
    for slice in clone.commits().chunks(2) {
        parts.push_str(&commit_lines(clone.repo(), slice).await.unwrap());
    }
    assert_eq!(parts, whole);
}

#[tokio::test]
async fn a_commit_past_the_changed_file_limit_lists_none_and_is_still_recorded() {
    let (_dir, url) = built(|path, dir| {
        write(path, "first", "x\n");
        ok(path, &["add", "-A"]);
        ok(path, &["commit", "-q", "-m", "small"]);
        // One blob at 100,001 paths: fast-import, since a worktree would take minutes.
        let tip = ok(path, &["rev-parse", "main"]);
        let when = "A <a@example.com> 1700000000 +0000";
        let mut stream = format!(
            "blob\nmark :1\ndata 2\nx\ncommit refs/heads/main\ncommitter {when}\ndata 5\nlarge\nfrom {tip}\n"
        );
        for n in 0..100_001 {
            stream.push_str(&format!("M 100644 :1 many/{}/{n}\n", n % 300));
        }
        stream.push('\n');
        let input = dir.join("stream");
        std::fs::write(&input, stream).unwrap();
        let import = format!("git fast-import --quiet < {}", input.display());
        let done = Command::new("sh")
            .current_dir(path)
            .args(["-c", &import])
            .status();
        assert!(done.unwrap().success());
    });
    let (clone, summary) = cloned_at(url).await;
    assert_eq!(summary["commits"], 2);
    let lines = history(&clone).await;
    assert_eq!(lines[0]["touches"].as_array().unwrap().len(), 1);
    assert_eq!(lines[1]["touches"], json!([]));
}

#[tokio::test]
async fn a_path_the_platform_refuses_stays_out_of_the_record_alone() {
    let (_dir, url) = built(|path, _| {
        write(path, "fine.txt", "x\n");
        write(path, "with:colon.txt", "y\n");
        ok(path, &["add", "-A"]);
        ok(path, &["commit", "-q", "-m", "one"]);
    });
    let (clone, _) = cloned_at(url).await;
    let touches = &history(&clone).await[0]["touches"];
    assert_eq!(touches.as_array().unwrap().len(), 1);
    assert_eq!(touches[0]["path"], "fine.txt");
}

#[tokio::test]
async fn the_refs_keep_their_real_ids_a_tag_object_byte_for_byte() {
    let remote = remote();
    let (clone, summary) = cloned(&remote).await;
    assert_eq!(summary["refs"], 5, "{summary}");
    assert_eq!(
        summary["refs_skipped"], 1,
        "a tag of a file names no commit"
    );
    let refs = clone.refs_json();
    let find = |name: &str| {
        refs.as_array()
            .unwrap()
            .iter()
            .find(|r| r["ref"] == name)
            .unwrap()
    };
    assert_eq!(find("refs/heads/main")["commit"], remote.tips[4].as_str());
    assert_eq!(find("refs/heads/side")["commit"], remote.side.as_str());
    assert_eq!(find("refs/heads/other")["commit"], remote.other.as_str());
    let light = find("refs/tags/light");
    assert_eq!(light["commit"], remote.tips[1].as_str());
    assert!(light.get("tag_b64").is_none());
    let annotated = find("refs/tags/v1");
    assert_eq!(annotated["commit"], remote.side.as_str());
    let data = STANDARD
        .decode(annotated["tag_b64"].as_str().unwrap())
        .unwrap();
    let id = ok(&remote.path, &["rev-parse", "v1"]);
    assert_eq!(hash_object(ObjectKind::Tag, &data).hex(), id);
}

#[tokio::test]
async fn a_tag_the_platform_could_not_keep_stays_as_a_ref_at_its_commit() {
    let (_dir, url) = built(|path, _| {
        write(path, "a", "x\n");
        ok(path, &["add", "-A"]);
        ok(path, &["commit", "-q", "-m", "one"]);
        // A tag of a tag, which `AnnotatedTag` does not take.
        ok(path, &["tag", "-a", "inner", "-m", "inner", "main"]);
        ok(path, &["tag", "-a", "outer", "-m", "outer", "inner"]);
    });
    let (clone, _) = cloned_at(url).await;
    let refs = clone.refs_json();
    let list = refs.as_array().unwrap();
    let main = &list.iter().find(|r| r["ref"] == "refs/heads/main").unwrap()["commit"];
    let outer = list.iter().find(|r| r["ref"] == "refs/tags/outer").unwrap();
    assert_eq!(&outer["commit"], main);
    assert!(outer.get("tag_b64").is_none());
}

#[tokio::test]
async fn a_commit_keeps_any_bytes_it_holds() {
    let mut raw = Vec::new();
    let (_dir, url) = built(|path, dir| {
        write(path, "a", "x\n");
        ok(path, &["add", "-A"]);
        let tree = ok(path, &["write-tree"]);
        // Written whole: `commit-tree` would mend the bytes this test is about.
        let who = "A <a@example.com> 1700000000 +0000";
        raw = format!("tree {tree}\nauthor {who}\ncommitter {who}\n\ncaf").into_bytes();
        raw.extend_from_slice(b"\xE9\n");
        let file = dir.join("commit");
        std::fs::write(&file, &raw).unwrap();
        let args = ["hash-object", "-t", "commit", "-w", file.to_str().unwrap()];
        let commit = ok(path, &args);
        ok(path, &["update-ref", "refs/heads/main", &commit]);
    });
    let (clone, _) = cloned_at(url).await;
    let line = &history(&clone).await[0];
    let kept = STANDARD.decode(line["data_b64"].as_str().unwrap()).unwrap();
    assert_eq!(kept, raw);
}

#[tokio::test]
async fn a_tree_git_reads_and_a_strict_decoder_would_not_is_kept_as_it_is() {
    let (_dir, url) = built(|path, dir| {
        let blob = ok(path, &["hash-object", "-w", "--stdin"]);
        // Mode `040000` with its leading zero, as old history holds.
        let inner = ok(path, &["mktree", "--missing"]);
        let mut raw = b"040000 sub\0".to_vec();
        raw.extend_from_slice(ObjectId::parse(&inner).unwrap().as_bytes());
        raw.extend_from_slice(b"100644 z\0");
        raw.extend_from_slice(ObjectId::parse(&blob).unwrap().as_bytes());
        let file = dir.join("tree");
        std::fs::write(&file, raw).unwrap();
        let args = [
            "hash-object",
            "-t",
            "tree",
            "-w",
            "--literally",
            file.to_str().unwrap(),
        ];
        let tree = ok(path, &args);
        let commit = ok(path, &["commit-tree", &tree, "-m", "old"]);
        ok(path, &["update-ref", "refs/heads/main", &commit]);
    });
    let (clone, summary) = cloned_at(url).await;
    assert_eq!(summary["commits"], 1);
    assert_eq!(
        history(&clone).await[0]["touches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn every_object_comes_out_once_with_its_exact_content_from_any_offset() {
    let remote = remote();
    let (clone, summary) = cloned(&remote).await;
    let framed = |from: usize| {
        let body = frames_body(clone.repo().to_owned(), clone.objects(), from);
        async move { axum::body::to_bytes(body, usize::MAX).await.unwrap() }
    };
    let bytes = framed(0).await;
    let mut at = 0;
    let mut seen = Vec::new();
    let mut starts = Vec::new();
    while at < bytes.len() {
        let kind = match bytes[at] {
            1 => ObjectKind::Commit,
            2 => ObjectKind::Tree,
            3 => ObjectKind::Blob,
            other => panic!("kind {other}"),
        };
        let id = ObjectId::from_bytes(bytes[at + 1..at + 21].try_into().unwrap());
        let size = u32::from_be_bytes(bytes[at + 21..at + 25].try_into().unwrap()) as usize;
        let content = &bytes[at + 25..at + 25 + size];
        assert_eq!(hash_object(kind, content), id, "content of {id}");
        seen.push(id);
        starts.push(at);
        at += 25 + size;
    }
    assert_eq!(summary["objects"], seen.len());
    let unique: std::collections::HashSet<_> = seen.iter().copied().collect();
    assert_eq!(unique.len(), seen.len(), "an object came out twice");
    assert_eq!(framed(3).await, bytes.slice(starts[3]..));
    assert!(framed(seen.len() + 10).await.is_empty());
}

#[tokio::test]
async fn a_pack_over_the_limit_is_refused_saying_so() {
    let remote = remote();
    let request = CloneRequest {
        max_pack_bytes: 10,
        ..asked(remote.url())
    };
    let Err(e) = clone_with(request, "file", &Credential::default()).await else {
        panic!("a pack over the limit was taken");
    };
    assert_eq!(e.code, "REPO_TOO_LARGE");
    assert!(e.message.contains("repository can hold"), "{}", e.message);
}

#[tokio::test]
async fn a_clone_past_its_time_limit_is_killed_with_all_it_started() {
    // A remote that never answers, with a child to outlive a kill of git alone.
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("still-running");
    let script = dir.path().join("hang.sh");
    let hang = format!(
        "#!/bin/sh\n(sleep 3; touch {}) &\nsleep 60\n",
        marker.display()
    );
    std::fs::write(&script, hang).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    hand_over(dir.path()).unwrap();
    let request = CloneRequest {
        timeout_seconds: 1,
        ..asked(format!("ext::{}", script.display()))
    };
    let started = Instant::now();
    let Err(e) = clone_with(request, "ext", &Credential::default()).await else {
        panic!("a hung clone finished");
    };
    assert_eq!(e.code, "TIME_LIMIT", "{}", e.message);
    assert!(started.elapsed() < Duration::from_secs(5));
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert!(!marker.exists(), "something the clone started outlived it");
}

#[test]
fn a_disk_that_ran_out_refuses_the_repository_and_anything_else_stays_a_failure() {
    let full = clone_failed("fatal: write error: No space left on device");
    assert_eq!(full.code, "REPO_TOO_LARGE");
    assert!(full.message.contains("more disk"), "{}", full.message);
    assert_eq!(
        clone_failed("fatal: repository not found").code,
        "GIT_FAILED"
    );
}

#[tokio::test]
async fn a_remote_with_no_commits_fails_saying_so() {
    let empty = tempfile::tempdir().unwrap();
    ok(empty.path(), &["init", "-q", "--bare", "-b", "main"]);
    hand_over(empty.path()).unwrap();
    let request = asked(format!("file://{}", empty.path().display()));
    let Err(e) = clone_with(request, "file", &Credential::default()).await else {
        panic!("an empty remote was cloned");
    };
    assert_eq!(e.code, "GIT_FAILED", "{}", e.message);
    assert!(e.message.contains("no commits"), "{}", e.message);
}

/// A remote that refuses everything and notes the header it was sent.
async fn refusing_remote() -> (String, Arc<Mutex<Option<String>>>) {
    let seen: Arc<Mutex<Option<String>>> = Arc::default();
    let noted = seen.clone();
    let app = axum::Router::new().fallback(move |headers: axum::http::HeaderMap| {
        let noted = noted.clone();
        async move {
            let sent = headers.get("authorization").and_then(|v| v.to_str().ok());
            *noted.lock().unwrap() = sent.map(str::to_owned);
            (axum::http::StatusCode::FORBIDDEN, "refused")
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/a/b.git", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

#[tokio::test]
async fn a_credential_reaches_git_by_environment_and_comes_back_in_nothing() {
    let (url, seen) = refusing_remote().await;
    let secret = "s3cret-credential";
    let credential = Credential::new(Some(secret.to_owned()));
    let Err(e) = clone_with(asked(url.clone()), "http", &credential).await else {
        panic!("a refusing remote was cloned");
    };
    let expected = STANDARD.encode(format!("x-access-token:{secret}"));
    assert_eq!(
        seen.lock().unwrap().take(),
        Some(format!("Basic {expected}"))
    );
    assert!(!e.message.contains(secret), "{}", e.message);
    assert!(!e.message.contains(&expected), "{}", e.message);
    // Without one, nothing is sent.
    let Err(_) = clone_with(asked(url), "http", &Credential::default()).await else {
        panic!("a refusing remote was cloned");
    };
    assert_eq!(seen.lock().unwrap().take(), None);
}

#[test]
fn only_a_plain_public_https_address_is_taken() {
    for good in [
        "https://github.com/spf13/pflag.git",
        "https://github.com/spf13/pflag",
        "https://example.com/a/b.git",
    ] {
        assert!(check_url(good).is_ok(), "{good}");
    }
    for bad in [
        "http://github.com/a/b.git",
        "ssh://git@github.com/a/b.git",
        "git@github.com:a/b.git",
        "file:///etc/passwd",
        "ext::sh -c id",
        "--upload-pack=x",
        "https://user:secret@github.com/a/b.git",
        "https://github.com:8443/a/b.git",
        "https://github.com/a/b.git?x=1",
        "https://github.com/a/b.git#x",
        "https://localhost/a/b.git",
        "https://LOCALHOST/a/b.git",
        "https://db.internal/a/b.git",
        "https://printer.local/a/b.git",
        "https://127.0.0.1/a/b.git",
        "https://10.0.0.1/a/b.git",
        "https://172.16.0.1/a/b.git",
        "https://192.168.1.1/a/b.git",
        "https://169.254.169.254/latest/meta-data",
        "https://100.64.0.1/a/b.git",
        "https://0.0.0.0/a/b.git",
        "https://[::1]/a/b.git",
        "https://[fe80::1]/a/b.git",
        "https://[fd00::1]/a/b.git",
        "https://[::ffff:10.0.0.1]/a/b.git",
        "https://2130706433/a/b.git",
        "https://0x7f.0.0.1/a/b.git",
        "https:///a/b.git",
    ] {
        assert!(check_url(bad).is_err(), "{bad} was taken");
    }
}

#[test]
fn an_address_a_name_resolves_to_is_held_to_the_same_rule() {
    for bad in [
        "127.0.0.1",
        "10.1.2.3",
        "172.31.0.1",
        "192.168.0.1",
        "169.254.1.1",
        "100.127.0.1",
        "0.0.0.0",
        "224.0.0.1",
        "255.255.255.255",
        "::1",
        "::",
        "fe80::1",
        "fc00::1",
        "ff02::1",
        "::ffff:192.168.0.1",
    ] {
        assert!(refused_address(bad.parse().unwrap()), "{bad}");
    }
    for good in [
        "140.82.112.3",
        "100.128.0.1",
        "2606:4700::1111",
        "::ffff:140.82.112.3",
    ] {
        assert!(!refused_address(good.parse().unwrap()), "{good}");
    }
}

#[tokio::test]
async fn a_private_address_is_refused_before_git_starts() {
    let request = asked("https://169.254.169.254/a/b.git".into());
    let Err(e) = clone_remote(request, &Credential::default()).await else {
        panic!("a link-local address was cloned");
    };
    assert_eq!(e.code, "INVALID_INPUT");
}

#[tokio::test]
async fn the_server_serves_a_clone_with_its_secret_only() {
    let remote = remote();
    let (clone, _) = cloned(&remote).await;
    let pack = std::fs::read(clone.pack()).unwrap();
    let lines = commit_lines(clone.repo(), clone.commits()).await.unwrap();
    let total = clone.commits().len();
    let app = routes_holding("s3cret".into(), Credential::default(), Some(clone));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    for path in [
        "/clone/pack",
        "/clone/objects?from=0",
        "/clone/commits?from=0&count=9",
        "/clone/refs",
    ] {
        let refused = client.get(format!("{url}{path}")).send().await.unwrap();
        assert_eq!(refused.status(), 403, "{path}");
    }
    let body = client
        .post(format!("{url}/clone"))
        .body(r#"{"url":"https://example.com/a/b.git"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(body.status(), 403);
    let read = |path: String| {
        client
            .get(format!("{url}{path}"))
            .bearer_auth("s3cret")
            .send()
    };
    let got = read("/clone/pack".into()).await.unwrap();
    assert_eq!(got.bytes().await.unwrap(), pack);
    let listed = read(format!("/clone/commits?from=0&count={total}"))
        .await
        .unwrap();
    assert_eq!(listed.text().await.unwrap(), lines);
    let past = read(format!("/clone/commits?from={}&count=9", total + 5)).await;
    assert_eq!(past.unwrap().text().await.unwrap(), "");
    let refs = read("/clone/refs".into())
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(refs.lines().count(), 5);
    let objects = read("/clone/objects?from=0".into()).await.unwrap();
    assert!(objects.status().is_success());
}

#[tokio::test]
async fn the_server_refuses_what_it_can_not_answer() {
    let app = routes_holding("s3cret".into(), Credential::default(), None);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let early = client
        .get(format!("{url}/clone/pack"))
        .bearer_auth("s3cret")
        .send()
        .await
        .unwrap();
    assert_eq!(early.status(), 422);
    let body = json!({
        "url": "http://github.com/a/b.git", "max_pack_bytes": GIB, "timeout_seconds": 60,
    });
    let refused = client
        .post(format!("{url}/clone"))
        .bearer_auth("s3cret")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), 422);
    let answer: Value = refused.json().await.unwrap();
    assert_eq!(answer["error"]["code"], "INVALID_INPUT");
}
