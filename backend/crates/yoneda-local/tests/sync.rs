//! Cloud sync acceptance (plan tests 8–13): each local repository paired with a cloud
//! repository. Every test runs against a second local service standing in for the cloud;
//! the `dev_` variants run the same steps against https://api.dev.yonedarepo.com and are
//! ignored by default (`cargo test -p yoneda-local --test sync -- --ignored`): they need
//! the owner's dev login and create fresh `local-sync-test-<ts>-<n>` repositories there.
mod support;
use support::cloud::{Kind, Pair};
use support::{Local, text};

fn state(v: &serde_json::Value) -> &str {
    v["sync"]["state"].as_str().unwrap_or_default()
}

/// 8. A local landing reaches cloud `main` by itself, with the same commit id.
fn local_landing_reaches_the_cloud(kind: Kind, n: u32) {
    let p = Pair::new(kind, n);
    let landed = p.local_land("wt-a", "a.txt", "a changed\n");
    assert!(
        p.wait_cloud_main(&landed, 60),
        "cloud main never became {landed}"
    );
    assert_eq!(p.cloud_show("a.txt"), "a changed");
    assert_eq!(state(&p.sync()), "synced");
}

/// 9. Concurrent landings on different files, one local and one on the cloud, converge.
fn concurrent_landings_converge(kind: Kind, n: u32) {
    let p = Pair::new(kind, n);
    p.cloud_land("c.txt", "from the cloud\n");
    p.local_land("wt-a", "a.txt", "a changed\n");
    let last = p.sync_until(5, |v| {
        state(v) == "synced" && v["main"] == v["sync"]["cloud"]["main"]
    });
    assert_eq!(state(&last), "synced", "{last}");
    assert_eq!(last["main"], last["sync"]["cloud"]["main"], "{last}");
    assert_eq!(p.cloud_show("a.txt"), "a changed");
    assert_eq!(p.cloud_show("c.txt"), "from the cloud");
    assert_eq!(p.client.show("main:c.txt"), "from the cloud");
}

/// 10. Conflicting edits: sync says so, and neither side's `main` is overwritten.
fn conflicting_edits_overwrite_nothing(kind: Kind, n: u32) {
    let p = Pair::new(kind, n);
    let cloud = p.cloud_land("list.txt", "ONE\ntwo\nthree\n");
    let local = p.local_land("wt-a", "list.txt", "uno\ntwo\nthree\n");
    let last = p.sync();
    assert_eq!(state(&last), "conflict", "{last}");
    assert_eq!(p.client.status()["main"], local);
    assert_eq!(p.cloud_main(), cloud);
    assert_eq!(p.client.show("main:list.txt"), "uno\ntwo\nthree");
}

/// 11. A refused cloud credential: sync says `refused`; local work keeps landing.
fn refused_credential_keeps_local_work(mut p: Pair, revoke: impl FnOnce(&Pair)) {
    let first = p.local_land("wt-a", "a.txt", "a changed\n");
    let ok = p.sync_until(3, |v| state(v) == "synced");
    assert_eq!(state(&ok), "synced", "{ok}");
    assert_eq!(p.cloud_main(), first);
    revoke(&p);
    let second = p.local_land("wt-b", "b.txt", "b changed\n");
    let last = p.sync();
    assert_eq!(state(&last), "refused", "{last}");
    assert_eq!(p.client.status()["main"], second);
    assert_eq!(p.cloud_main(), first);
    p.client.kill();
}

/// 12. Offline: local landings keep landing; on reconnect they go up in order.
fn offline_then_reconnect(
    mut p: Pair,
    cut: impl FnOnce(&mut Pair),
    restore: impl FnOnce(&mut Pair),
) {
    cut(&mut p);
    p.local_land("wt-a", "a.txt", "a changed\n");
    p.local_land("wt-b", "b.txt", "b changed\n");
    let last = p.sync();
    assert_eq!(state(&last), "offline", "{last}");
    assert_eq!(last["sync"]["unsynced"], 2, "{last}");
    restore(&mut p);
    let last = p.sync_until(3, |v| state(v) == "synced");
    assert_eq!(state(&last), "synced", "{last}");
    assert_eq!(p.cloud_main(), p.client.status()["main"].as_str().unwrap());
    let log = p.cloud_log();
    let a = log
        .iter()
        .position(|s| s == "edit a.txt")
        .expect("a on the cloud");
    let b = log
        .iter()
        .position(|s| s.starts_with("edit b.txt") || s.contains("b.txt"));
    assert!(
        b.is_some_and(|b| b < a) || log[0].contains("Merge"),
        "{log:?}"
    );
}

#[test]
fn local_landing_reaches_the_cloud_stand_in() {
    local_landing_reaches_the_cloud(Kind::Local, 8);
}

#[test]
fn concurrent_landings_converge_stand_in() {
    concurrent_landings_converge(Kind::Local, 9);
}

#[test]
fn conflicting_edits_overwrite_nothing_stand_in() {
    conflicting_edits_overwrite_nothing(Kind::Local, 10);
}

#[test]
fn refused_credential_keeps_local_work_stand_in() {
    let p = Pair::new(Kind::Local, 11);
    let wrong = "ylt_0000000000000000000000000000000000000000000000000000000000000000";
    let mut p = p;
    refused_credential_keeps_local_work_restart(&mut p, wrong);
}

fn refused_credential_keeps_local_work_restart(p: &mut Pair, wrong: &str) {
    let first = p.local_land("wt-a", "a.txt", "a changed\n");
    let ok = p.sync_until(3, |v| state(v) == "synced");
    assert_eq!(state(&ok), "synced", "{ok}");
    assert_eq!(p.cloud_main(), first);
    p.restart_client(&[("YONEDA_TOKEN", wrong)]);
    let second = p.local_land("wt-b", "b.txt", "b changed\n");
    let last = p.sync();
    assert_eq!(state(&last), "refused", "{last}");
    assert_eq!(p.client.status()["main"], second);
    assert_eq!(p.cloud_main(), first);
}

#[test]
fn offline_then_reconnect_stand_in() {
    let p = Pair::new(Kind::Local, 12);
    offline_then_reconnect(
        p,
        |p| p.cloud.as_mut().unwrap().kill(),
        |p| p.cloud.as_mut().unwrap().serve(),
    );
}

/// 13 (stand-in): with no yoneda remote and no login, init works locally and says it is
/// not paired, without touching any network.
#[test]
fn unpaired_without_a_login() {
    let l = Local::new();
    let status = support::cloud::sync_json(&l);
    assert_eq!(status["sync"]["state"], "unpaired", "{status}");
    assert!(status["sync"]["cloud"].is_null());
}

#[test]
#[ignore = "live: needs the owner's dev login; creates a repository on dev"]
fn dev_local_landing_reaches_the_cloud() {
    local_landing_reaches_the_cloud(Kind::Dev, 8);
}

#[test]
#[ignore = "live: needs the owner's dev login; creates a repository on dev"]
fn dev_concurrent_landings_converge() {
    concurrent_landings_converge(Kind::Dev, 9);
}

#[test]
#[ignore = "live: needs the owner's dev login; creates a repository on dev"]
fn dev_conflicting_edits_overwrite_nothing() {
    conflicting_edits_overwrite_nothing(Kind::Dev, 10);
}

#[test]
#[ignore = "live: needs the owner's dev login; creates a repository on dev"]
fn dev_revoked_token_keeps_local_work() {
    let mut p = Pair::new(Kind::Dev, 11);
    let name = format!("local-sync-{}", std::process::id());
    let token = p.dev_token_create(&name);
    p.restart_client(&[("YONEDA_TOKEN", token.as_str())]);
    refused_credential_keeps_local_work(p, |p| p.dev_token_revoke(&name));
}

#[test]
#[ignore = "live: needs the owner's dev login; creates a repository on dev"]
fn dev_offline_then_reconnect() {
    let p = Pair::new(Kind::Dev, 12);
    offline_then_reconnect(
        p,
        // A dead proxy: the network is unreachable for the service's Git.
        |p| {
            p.restart_client(&[
                ("HTTPS_PROXY", "http://127.0.0.1:9"),
                ("https_proxy", "http://127.0.0.1:9"),
            ])
        },
        |p| p.restart_client(&[]),
    );
}

/// Test 13: a clone with no yoneda remote. Init creates a cloud repository, pushes the
/// history of `main` (same ids) and takes its id.
#[test]
#[ignore = "live: needs the owner's dev login; creates a repository on dev"]
fn dev_init_creates_and_fills_a_cloud_repository() {
    let mut l = Local::uninitialized(
        &support::cloud::dev_name(13),
        &[
            ("YONEDA_TOKEN", support::cloud::dev_token().as_str()),
            ("YONEDA_ORIGIN", support::cloud::DEV),
        ],
    );
    l.seed();
    l.commit(&l.clone.clone(), "a.txt", "second\n");
    l.commit(&l.clone.clone(), "b.txt", "third\n");
    let history = l.git_ok(&l.clone, &["rev-list", "main"]);
    let said = l.run_ok(&l.clone, &["init"]);
    assert!(said.contains("paired with"), "{said}");
    let status = support::cloud::sync_json(&l);
    let repo = status["sync"]["cloud"]["repo"].as_str().unwrap().to_owned();
    assert!(status["url"].as_str().unwrap().contains(&repo), "{status}");
    let remote = l.git_ok(&l.clone, &["remote", "get-url", "local"]);
    assert!(remote.contains(&repo), "{remote}");
    l.serve();
    let url = format!("{}/git/{repo}.git", support::cloud::DEV);
    let into = l.dir.path().join("check");
    let cloned = support::cloud::cloud_git(
        &l,
        l.dir.path(),
        support::cloud::DEV,
        &["clone", "-q", &url, into.to_str().unwrap()],
    );
    assert!(cloned.status.success(), "{}", text(&cloned));
    assert_eq!(l.git_ok(&into, &["rev-list", "main"]), history);
}
