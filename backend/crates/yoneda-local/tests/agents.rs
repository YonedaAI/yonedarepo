//! What sandboxed agents need from a clone's local service: their own tokens (each lands as
//! its own principal and stops at revocation), and a `sync` that leaves a running service's
//! PID record alone.
mod support;

use support::{Local, text};

/// Pushes `wt`'s HEAD to `main` with `token` as the only credential Git has.
fn push_as(l: &Local, wt: &std::path::Path, token: &str) -> std::process::Output {
    let url = l.git_ok(&l.clone, &["remote", "get-url", "local"]);
    let origin = url.split("/git/").next().unwrap().to_owned();
    let reset = format!("credential.{origin}.helper=");
    let header = format!("http.{origin}/.extraHeader=Authorization: Bearer {token}");
    l.git(
        wt,
        &[
            "-c",
            &reset,
            "-c",
            &header,
            "push",
            "local",
            "HEAD:refs/heads/main",
        ],
    )
}

/// `token create` prints the secret once, on stdout only; the token lands as
/// `token:<name>`; `list` names it without its secret; after `revoke` it is refused.
#[test]
fn an_agent_token_lands_as_its_own_principal_until_revoked() {
    let mut l = Local::new();
    l.serve();
    let made = l.run(&l.clone, &["token", "create", "agent-a"]);
    assert!(made.status.success(), "{}", text(&made));
    let secret = String::from_utf8_lossy(&made.stdout).trim().to_owned();
    assert!(
        secret.starts_with("ylt_") && !secret.contains('\n'),
        "stdout is the secret alone"
    );
    let note = String::from_utf8_lossy(&made.stderr);
    assert!(note.contains("token:agent-a"), "{note}");
    assert!(
        !note.contains(&secret),
        "the secret is printed once, on stdout"
    );

    let listed = l.run_ok(&l.clone, &["token", "list"]);
    assert!(listed.contains("agent-a"), "{listed}");
    assert!(!listed.contains(&secret), "list never shows a secret");

    let a = l.worktree("wt-a");
    l.commit(&a, "a.txt", "agent a\n");
    let pushed = push_as(&l, &a, &secret);
    assert!(pushed.status.success(), "{}", text(&pushed));
    let landed = l.run_ok(&l.clone, &["log", "--json"]);
    assert!(landed.contains("token:agent-a"), "{landed}");

    l.run_ok(&l.clone, &["token", "revoke", "agent-a"]);
    l.commit(&a, "b.txt", "after revocation\n");
    let refused = push_as(&l, &a, &secret);
    assert!(!refused.status.success(), "{}", text(&refused));
}

/// The service's own tokens cannot be revoked or replaced from the command line.
#[test]
fn the_service_tokens_are_reserved() {
    let l = Local::new();
    for name in ["local", "cloud-sync"] {
        let revoked = l.run(&l.clone, &["token", "revoke", name]);
        assert!(!revoked.status.success(), "{}", text(&revoked));
        let made = l.run(&l.clone, &["token", "create", name]);
        assert!(!made.status.success(), "{}", text(&made));
    }
}

/// `yoneda local sync` with no service running runs the round itself and leaves `serve.pid`
/// as it was (it names the last `serve`, not this command).
#[test]
fn sync_without_a_service_leaves_the_pid_record_alone() {
    let l = Local::new();
    let pid = l.clone.join(".git/yoneda/local/serve.pid");
    std::fs::write(&pid, "424242").unwrap();
    let synced = l.run(&l.clone, &["sync"]);
    assert!(synced.status.success(), "{}", text(&synced));
    assert_eq!(std::fs::read_to_string(&pid).unwrap(), "424242");
}
