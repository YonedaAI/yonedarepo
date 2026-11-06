//! A development landing branch stays separate from the release branch, including
//! concurrent pushes, stale reads, restart recovery and disabled cloud publication.
mod support;

use support::{Local, text};

#[test]
fn dev_landings_merge_and_refuse_conflicts_without_moving_main() {
    let mut l = Local::new();
    let main = l.store_ref("main");
    l.git_ok(&l.clone, &["switch", "-qc", "dev"]);
    l.run_ok(&l.clone, &["configure", "--branch", "dev", "--no-cloud"]);
    l.serve();
    let state = l.status();
    assert_eq!(state["branch"], "dev");
    assert_eq!(state["head"], main);
    assert_eq!(state["sync"]["state"], "disabled");
    // Reconfiguration cannot race an active landing/sync thread.
    assert!(
        !l.run(&l.clone, &["configure", "--branch", "main"])
            .status
            .success()
    );
    let a = l.worktree("a");
    let b = l.worktree("b");
    let c = l.worktree("c");
    l.commit(&a, "a.txt", "writer a\n");
    l.commit(&b, "b.txt", "writer b\n");
    l.commit(&c, "a.txt", "conflicting writer\n");
    for wt in [&a, &b] {
        let out = l.git(wt, &["push", "local", "HEAD:dev"]);
        assert!(out.status.success(), "{}", text(&out));
    }
    assert_eq!(l.show("dev:a.txt"), "writer a");
    assert_eq!(l.show("dev:b.txt"), "writer b");
    let merged = l.store_ref("dev");
    let refused = l.git(&c, &["push", "local", "HEAD:dev"]);
    assert!(!refused.status.success(), "{}", text(&refused));
    assert!(
        text(&refused).contains("conflict in a.txt"),
        "{}",
        text(&refused)
    );
    assert_eq!(l.store_ref("main"), main);
    assert_eq!(l.store_ref("dev"), merged);
    let deleted = l.git(&a, &["push", "local", ":dev"]);
    assert!(!deleted.status.success(), "{}", text(&deleted));
    l.kill();
    // The clone's dev is still at the seed: reconfiguration must keep accepted work.
    l.run_ok(&l.clone, &["configure", "--branch", "dev", "--no-cloud"]);
    l.serve();
    assert_eq!(l.status()["head"], merged);
    assert_eq!(l.status()["sync"]["state"], "disabled");
    assert_eq!(
        l.git_ok(&l.store(), &["symbolic-ref", "HEAD"]),
        "refs/heads/dev"
    );
}

#[test]
fn init_imports_dev_and_never_pairs_when_cloud_is_disabled() {
    let l = Local::uninitialized(
        "clone",
        &[
            ("YONEDA_ORIGIN", "http://127.0.0.1:1"),
            ("YONEDA_TOKEN", "test-only-token"),
        ],
    );
    l.seed();
    let main = l.git_ok(&l.clone, &["rev-parse", "main"]);
    l.git_ok(&l.clone, &["switch", "-qc", "dev"]);
    let dev = l.commit(&l.clone, "a.txt", "dev only\n");
    l.run_ok(&l.clone, &["init", "--branch", "dev", "--no-cloud"]);
    let state = l.status();
    assert_eq!(state["branch"], "dev");
    assert_eq!(state["head"], dev);
    assert_eq!(state["sync"]["state"], "disabled");
    assert!(state["sync"]["cloud"].is_null());
    assert_eq!(l.git_ok(&l.clone, &["rev-parse", "main"]), main);
    assert!(
        !l.run(&l.clone, &["configure", "--branch", "../bad"])
            .status
            .success()
    );
    assert_eq!(l.status()["branch"], "dev");
}

#[test]
fn dev_checks_and_declared_reads_are_enforced() {
    let mut l = Local::new();
    l.git_ok(&l.clone, &["branch", "dev"]);
    l.run_ok(&l.clone, &["configure", "--branch", "dev", "--no-cloud"]);
    l.run_ok(
        &l.clone,
        &[
            "check",
            "add",
            "not-bad",
            "--on-host",
            "--",
            "sh",
            "-c",
            "! grep -q bad a.txt",
        ],
    );
    l.serve();
    let a = l.worktree("a");
    let b = l.worktree("b");
    l.commit(&a, "a.txt", "bad\n");
    let refused = l.git(&a, &["push", "local", "HEAD:dev"]);
    assert!(!refused.status.success(), "{}", text(&refused));
    assert!(
        text(&refused).contains("check not-bad failed"),
        "{}",
        text(&refused)
    );
    l.commit(&a, "a.txt", "good\n");
    assert!(l.git(&a, &["push", "local", "HEAD:dev"]).status.success());
    let before = l.store_ref("dev");
    l.commit(&b, "b.txt", "depends on a\n");
    let refused = l.git(
        &b,
        &["push", "-o", "yoneda.reads=a.txt", "local", "HEAD:dev"],
    );
    assert!(!refused.status.success(), "{}", text(&refused));
    assert!(
        text(&refused).contains("read conflict"),
        "{}",
        text(&refused)
    );
    assert_eq!(l.store_ref("dev"), before);
}

#[test]
fn configured_sync_uses_dev_in_both_directions_and_preserves_main() {
    let mut cloud = Local::new();
    let main = cloud.store_ref("main");
    cloud.git_ok(&cloud.clone, &["branch", "dev"]);
    cloud.run_ok(
        &cloud.clone,
        &["configure", "--branch", "dev", "--no-cloud"],
    );
    cloud.serve();
    let url = cloud.status()["url"].as_str().unwrap().to_owned();
    let token = std::fs::read_to_string(cloud.clone.join(".git/yoneda/local/token")).unwrap();
    let mut client = Local::uninitialized("client", &[("YONEDA_TOKEN", token.trim())]);
    let origin = url.split("/git/").next().unwrap();
    let cloned = support::cloud::cloud_git(
        &client,
        client.dir.path(),
        origin,
        &["clone", "-q", &url, client.clone.to_str().unwrap()],
    );
    assert!(cloned.status.success(), "{}", text(&cloned));
    client.run_ok(&client.clone, &["init", "--branch", "dev"]);
    client.serve();
    client.commit(&client.clone, "a.txt", "local edit\n");
    assert!(
        client
            .git(&client.clone, &["push", "local", "HEAD:dev"])
            .status
            .success()
    );
    client.run_ok(&client.clone, &["sync"]);
    assert_eq!(cloud.show("dev:a.txt"), "local edit");
    cloud.git_ok(&cloud.clone, &["fetch", "local", "dev"]);
    cloud.git_ok(&cloud.clone, &["switch", "-C", "dev", "FETCH_HEAD"]);
    cloud.commit(&cloud.clone, "b.txt", "cloud edit\n");
    assert!(
        cloud
            .git(&cloud.clone, &["push", "local", "HEAD:dev"])
            .status
            .success()
    );
    client.run_ok(&client.clone, &["sync"]);
    assert_eq!(client.show("dev:b.txt"), "cloud edit");
    assert_eq!(cloud.store_ref("main"), main);
    assert_eq!(client.status()["sync"]["cloud"]["branch"], "dev");
}
