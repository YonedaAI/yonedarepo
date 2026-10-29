//! `yoneda clone` of a repository that withholds a blob (quarantine), both ways. The lazy
//! `yoneda::` clone never fetches a blob Git does not need. `--offline` is refused a direct
//! object-store clone and takes the API snapshot. Either completes when the withheld blob is
//! only in history, and otherwise fails naming the quarantined path, never its content.
//! Run with `cargo test -p yoneda-cli --test quarantine_clone -- --include-ignored`; it
//! needs the workspace's node modules (wrangler) and the Rust Wasm worker build.
#[allow(dead_code)] // shared with the other platform tests
mod support;

use serde_json::json;
use support::{Client, Platform, TestResult};

const SECRET: &str = "staging password: hunter2-quarantine\n";

/// A person signed up on the platform, made a reader of `repo`, with a personal access
/// token as `yoneda login` leaves one: unlike a repository token, it may ask for a direct
/// clone of the object store.
fn reader(platform: &Platform, repo: &str, name: &str) -> TestResult<Client> {
    let http = reqwest::Client::new();
    let origin = &platform.origin;
    let cookie = platform.rt.block_on(async {
        let signed = http
            .post(format!("{origin}/api/auth/signup"))
            .json(&json!({ "username": name, "email": format!("{name}@example.com"), "password": "long platform test password" }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let cookie = signed
            .headers()
            .get("set-cookie")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::to_owned);
        let Some(cookie) = cookie else {
            let status = signed.status();
            let body = signed.text().await.unwrap_or_default();
            return Err(format!("signup answered {status}: {body}"));
        };
        Ok::<_, String>(cookie)
    })?;
    platform.owner_call(
        "POST",
        &format!("/repos/{repo}/members"),
        Some(json!({ "account": name, "role": "read" })),
    )?;
    let token = platform.rt.block_on(async {
        let minted: serde_json::Value = http
            .post(format!("{origin}/api/v1/tokens"))
            .header("cookie", &cookie)
            .json(&json!({ "name": "cli", "scopes": ["repo:read"] }))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        minted["token"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("no token: {minted}"))
    })?;
    let home = platform.scratch.path().join(format!("home-{name}"));
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    Ok(Client { home, token })
}

/// The clone mode's name, for account names.
fn label(how: &[&str]) -> &'static str {
    if how.contains(&"--offline") {
        "offline"
    } else {
        "lazy"
    }
}

/// Quarantines the file at `path` as of `at` (a commit or branch).
fn quarantine(platform: &Platform, repo: &str, path: &str, at: &str) -> TestResult<()> {
    platform.owner_call(
        "POST",
        &format!("/repos/{repo}/quarantine"),
        Some(json!({ "path": path, "ref": at, "reason": "a leaked password" })),
    )?;
    Ok(())
}

fn a_withheld_blob_in_history_does_not_stop_a_clone(
    platform: &Platform,
    how: &[&str],
) -> TestResult {
    let (repo, _) = platform.repo(&[("config/staging.txt", SECRET), ("a.txt", "a\n")])?;
    let (_, first, _) = platform.main(&repo)?;
    platform.other_writer(&repo, &[("config/staging.txt", "rotated\n")])?;
    quarantine(platform, &repo, "config/staging.txt", &first)?;
    let c = reader(platform, &repo, &format!("{}_history", label(how)))?;
    let mut args = vec!["clone", &repo, "work", "--origin", &platform.origin];
    args.extend(how);
    c.ok(&c.home, &args)?;
    let work = c.home.join("work");
    let read = |path: &str| std::fs::read_to_string(work.join(path)).map_err(|e| e.to_string());
    if read("config/staging.txt")? != "rotated\n" || read("a.txt")? != "a\n" {
        return Err("the clone does not hold main's files".into());
    }
    Ok(())
}

fn a_withheld_blob_at_head_fails_the_clone_naming_it(
    platform: &Platform,
    how: &[&str],
) -> TestResult {
    let (repo, _) = platform.repo(&[("config/staging.txt", SECRET), ("a.txt", "a\n")])?;
    quarantine(platform, &repo, "config/staging.txt", "main")?;
    let c = reader(platform, &repo, &format!("{}_head", label(how)))?;
    let mut args = vec!["clone", &repo, "work", "--origin", &platform.origin];
    args.extend(how);
    let out = c.yoneda(&c.home, &args)?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success()
        || !stderr.contains("quarantined")
        || !stderr.contains("config/staging.txt")
        || stderr.contains("requesting clone access")
        || stderr.contains("hunter2")
    {
        return Err(format!(
            "expected a failure naming the quarantined path, got {:?}: {stderr}",
            out.status.code()
        ));
    }
    Ok(())
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli -- --include-ignored"]
fn clones_around_quarantined_content() -> TestResult {
    let platform = Platform::start()?;
    for (how, label) in [(&[][..], "lazy"), (&["--offline"][..], "offline")] {
        a_withheld_blob_in_history_does_not_stop_a_clone(&platform, how)
            .map_err(|e| format!("{label} history: {e}"))?;
        a_withheld_blob_at_head_fails_the_clone_naming_it(&platform, how)
            .map_err(|e| format!("{label} head: {e}"))?;
    }
    Ok(())
}
