//! Acceptance for the local service (docs/local-repository-future.md): two linked
//! worktrees of one clone push to one local `main` with stock Git.
mod support;
use support::{Local, text};

/// 1. Disjoint edits from the same base both land; `main` holds both.
#[test]
fn disjoint_edits_from_the_same_base_both_land() {
    let mut l = Local::new();
    l.serve();
    let a = l.worktree("wt-a");
    let b = l.worktree("wt-b");
    l.commit(&a, "a.txt", "a changed\n");
    l.commit(&b, "b.txt", "b changed\n");
    let pa = l.push(&a, &[]);
    assert!(pa.status.success(), "{}", text(&pa));
    let pb = l.push(&b, &[]);
    assert!(pb.status.success(), "{}", text(&pb));
    assert!(
        text(&pb).contains("landed with server merge"),
        "{}",
        text(&pb)
    );
    assert_eq!(l.show("main:a.txt"), "a changed");
    assert_eq!(l.show("main:b.txt"), "b changed");
    assert_eq!(l.status()["main"], l.store_ref("main"));
    l.git_ok(&l.store(), &["fsck", "--strict", "--no-dangling"]);
}

/// 2. Same-line edits: the second is refused, `main` is unchanged, its branch is kept.
#[test]
fn same_line_edits_refuse_the_second_and_keep_its_branch() {
    let mut l = Local::new();
    l.serve();
    let a = l.worktree("wt-a");
    let b = l.worktree("wt-b");
    let ca = l.commit(&a, "list.txt", "ONE\ntwo\nthree\n");
    let cb = l.commit(&b, "list.txt", "uno\ntwo\nthree\n");
    assert!(l.push(&a, &[]).status.success());
    let kept = l.git(&b, &["push", "local", "HEAD:refs/heads/wt-b"]);
    assert!(kept.status.success(), "{}", text(&kept));
    let refused = l.push(&b, &[]);
    assert!(!refused.status.success());
    assert!(text(&refused).contains("conflict"), "{}", text(&refused));
    assert_eq!(l.store_ref("main"), ca);
    assert_eq!(l.status()["main"], ca);
    assert_eq!(l.store_ref("wt-b"), cb);
}

/// 3. A declared read written after the change's base refuses the landing.
#[test]
fn a_stale_declared_read_is_refused() {
    let mut l = Local::new();
    l.serve();
    let a = l.worktree("wt-a");
    let b = l.worktree("wt-b");
    l.commit(&a, "a.txt", "a changed\n");
    l.commit(&b, "b.txt", "b changed\n");
    assert!(l.push(&a, &[]).status.success());
    let before = l.status()["main"].clone();
    let refused = l.push(&b, &["-o", "yoneda.reads=a.txt"]);
    assert!(!refused.status.success());
    assert!(
        text(&refused).contains("read conflict"),
        "{}",
        text(&refused)
    );
    assert_eq!(l.status()["main"], before);
}

/// 4. Killed after recording, before answering: the retried push lands exactly once.
#[test]
fn a_push_retried_after_a_crash_lands_once() {
    let mut l = Local::new();
    let marker = l.dir.path().join("paused");
    let m = marker.to_str().unwrap().to_owned();
    l.serve_with(&[
        ("YONEDA_LOCAL_PAUSE", "after_record"),
        ("YONEDA_LOCAL_PAUSE_FILE", &m),
    ]);
    let a = l.worktree("wt-a");
    let ca = l.commit(&a, "a.txt", "a changed\n");
    let before = l.status()["version"].as_u64().unwrap();
    let push = {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["push", "local", "HEAD:refs/heads/main"])
            .current_dir(&a)
            .env("HOME", l.home())
            .env("GIT_CONFIG_GLOBAL", l.home().join(".gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        cmd.spawn().unwrap()
    };
    Local::wait_for(&marker);
    l.kill();
    let mut push = push;
    assert!(!push.wait().unwrap().success());
    l.serve();
    let retried = l.push(&a, &[]);
    assert!(retried.status.success(), "{}", text(&retried));
    let after = l.status();
    assert_eq!(after["main"], ca);
    assert_eq!(after["version"].as_u64().unwrap(), before + 1);
    l.git_ok(&l.store(), &["cat-file", "-e", &ca]);
    l.git_ok(&l.store(), &["fsck", "--strict", "--no-dangling"]);
}

/// 5. Killed between the authority's commit and the ref update: restart reconciles.
#[test]
fn restart_reconciles_a_ref_the_crash_left_behind() {
    let mut l = Local::new();
    let marker = l.dir.path().join("paused");
    let m = marker.to_str().unwrap().to_owned();
    l.serve_with(&[
        ("YONEDA_LOCAL_PAUSE", "after_land"),
        ("YONEDA_LOCAL_PAUSE_FILE", &m),
    ]);
    let a = l.worktree("wt-a");
    let old = l.store_ref("main");
    let ca = l.commit(&a, "a.txt", "a changed\n");
    let mut push = {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["push", "local", "HEAD:refs/heads/main"])
            .current_dir(&a)
            .env("HOME", l.home())
            .env("GIT_CONFIG_GLOBAL", l.home().join(".gitconfig"))
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        cmd.spawn().unwrap()
    };
    Local::wait_for(&marker);
    l.kill();
    let _ = push.wait();
    assert_eq!(
        l.store_ref("main"),
        old,
        "the ref update had not happened yet"
    );
    l.serve();
    assert_eq!(l.store_ref("main"), ca);
    assert_eq!(l.status()["main"], ca);
}

/// 6. A second `serve` refuses while the first holds the lock.
#[test]
fn a_second_service_refuses_to_start() {
    let mut l = Local::new();
    l.serve();
    let second = l.run(&l.clone, &["serve"]);
    assert!(!second.status.success());
    assert!(
        text(&second).contains("already running"),
        "{}",
        text(&second)
    );
}

/// 7. Without the token, or with a wrong one, Git is refused and nothing moves.
#[test]
fn pushes_without_the_token_are_refused() {
    let mut l = Local::new();
    l.serve();
    let a = l.worktree("wt-a");
    l.commit(&a, "a.txt", "a changed\n");
    let before = l.status()["main"].clone();
    let url = l.git_ok(&l.clone, &["remote", "get-url", "local"]);
    let origin = url.split("/git/").next().unwrap().to_owned();
    let reset = format!("credential.{origin}.helper=");
    let none = l.git(&a, &["-c", &reset, "push", "local", "HEAD:refs/heads/main"]);
    assert!(!none.status.success(), "{}", text(&none));
    let wrong = format!(
        "credential.{origin}.helper=!f() {{ echo username=x; echo password=wrong-token; }}; f"
    );
    let bad = l.git(
        &a,
        &[
            "-c",
            &reset,
            "-c",
            &wrong,
            "push",
            "local",
            "HEAD:refs/heads/main",
        ],
    );
    assert!(!bad.status.success(), "{}", text(&bad));
    let fetch = l.git(&a, &["-c", &reset, "fetch", "local"]);
    assert!(!fetch.status.success(), "{}", text(&fetch));
    assert_eq!(l.status()["main"], before);
}
