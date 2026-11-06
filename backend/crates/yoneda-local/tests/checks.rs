//! Local checks (`yoneda local check`): the owner's commands run on the exact revision that
//! would land on `main` (the pushed commit for a fast-forward, the platform's merge commit
//! otherwise), and a failure refuses the landing with `main` unchanged.
mod support;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};
use support::{Local, text};

fn check(l: &Local, name: &str, script: &str, extra: &[&str]) {
    let mut args = vec!["check", "add", name];
    args.extend_from_slice(extra);
    args.extend_from_slice(&["--on-host", "--", "sh", "-c", script]);
    l.run_ok(&l.clone, &args);
}

#[test]
fn a_failing_check_refuses_a_fast_forward() {
    let mut l = Local::new();
    check(&l, "no-bad", "! grep -q bad a.txt", &[]);
    l.serve();
    let a = l.worktree("wt-a");
    let before = l.store_ref("main");
    l.commit(&a, "a.txt", "bad\n");
    let refused = l.push(&a, &[]);
    assert!(!refused.status.success(), "{}", text(&refused));
    assert!(
        text(&refused).contains("check no-bad failed"),
        "{}",
        text(&refused)
    );
    assert_eq!(l.store_ref("main"), before);
    let good = l.commit(&a, "a.txt", "good\n");
    let landed = l.push(&a, &[]);
    assert!(landed.status.success(), "{}", text(&landed));
    assert_eq!(l.store_ref("main"), good);
}

/// Each push passes alone; together they fail. The second is refused on the merged result,
/// which exists in no worktree.
#[test]
fn checks_run_on_the_merged_result() {
    let mut l = Local::new();
    check(&l, "not-both", "! { test -f x.txt && test -f y.txt; }", &[]);
    l.serve();
    let a = l.worktree("wt-a");
    let b = l.worktree("wt-b");
    let ca = l.commit(&a, "x.txt", "x\n");
    l.commit(&b, "y.txt", "y\n");
    assert!(l.push(&a, &[]).status.success());
    let refused = l.push(&b, &[]);
    assert!(!refused.status.success(), "{}", text(&refused));
    let said = text(&refused);
    assert!(
        said.contains("check not-both failed on the merged result"),
        "{said}"
    );
    assert_eq!(l.store_ref("main"), ca);
    assert_eq!(l.status()["main"], ca);
}

#[test]
fn concurrent_pushes_with_a_passing_check_all_land() {
    const WRITERS: usize = 4;
    let mut l = Local::new();
    check(&l, "has-base", "test -f a.txt", &[]);
    l.serve();
    let trees: Vec<_> = (0..WRITERS).map(|i| l.worktree(&format!("w{i}"))).collect();
    for (i, wt) in trees.iter().enumerate() {
        l.commit(wt, &format!("w{i}.txt"), "w\n");
    }
    let gate = Arc::new(Barrier::new(WRITERS));
    let pushes: Vec<_> = trees
        .iter()
        .map(|wt| {
            let mut cmd = l.push_command(wt, &[]);
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                cmd.output().unwrap()
            })
        })
        .collect();
    for p in pushes {
        let out = p.join().unwrap();
        assert!(out.status.success(), "{}", text(&out));
    }
    for i in 0..WRITERS {
        assert_eq!(l.show(&format!("main:w{i}.txt")), "w");
    }
}

#[test]
fn a_check_that_runs_too_long_is_stopped_and_refuses() {
    let mut l = Local::new();
    check(&l, "slow", "sleep 30", &["--timeout", "1"]);
    l.serve();
    let a = l.worktree("wt-a");
    l.commit(&a, "a.txt", "a changed\n");
    let began = Instant::now();
    let refused = l.push(&a, &[]);
    assert!(began.elapsed() < Duration::from_secs(20));
    assert!(!refused.status.success(), "{}", text(&refused));
    assert!(text(&refused).contains("timed out"), "{}", text(&refused));
    l.run_ok(&l.clone, &["check", "remove", "slow"]);
    let landed = l.push(&a, &[]);
    assert!(landed.status.success(), "{}", text(&landed));
}

#[test]
fn checks_are_listed_and_removed() {
    let l = Local::new();
    check(&l, "lint", "true", &[]);
    let listed = l.run_ok(&l.clone, &["check", "list"]);
    assert!(
        listed.contains("lint") && listed.contains("on host"),
        "{listed}"
    );
    l.run_ok(&l.clone, &["check", "remove", "lint"]);
    assert!(!l.run_ok(&l.clone, &["check", "list"]).contains("lint"));
}

/// Where a check runs is the owner's explicit choice: on this machine or in a container.
#[test]
fn adding_a_check_needs_on_host_or_an_image() {
    let l = Local::new();
    let out = l.run(&l.clone, &["check", "add", "lint", "--", "true"]);
    assert!(!out.status.success());
    assert!(
        text(&out).contains("--on-host or --image"),
        "{}",
        text(&out)
    );
}

/// In Docker with no network: needs a running Docker and the image pulled.
#[test]
#[ignore = "needs Docker"]
fn a_check_runs_in_a_container() {
    let mut l = Local::new();
    l.run_ok(
        &l.clone,
        &[
            "check",
            "add",
            "in-box",
            "--image",
            "alpine:3.22",
            "--",
            "sh",
            "-c",
            "! grep -q bad a.txt",
        ],
    );
    l.serve();
    let a = l.worktree("wt-a");
    l.commit(&a, "a.txt", "bad\n");
    let refused = l.push(&a, &[]);
    assert!(
        text(&refused).contains("check in-box failed"),
        "{}",
        text(&refused)
    );
    l.commit(&a, "a.txt", "fine\n");
    assert!(l.push(&a, &[]).status.success());
}
