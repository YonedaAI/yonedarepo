//! The sandbox team flow over any transport: two members on the frozen base edit
//! README.md line 1; Alpha lands on the team branch and Beta's landing conflicts. Beta
//! merges the fetched team branch (a conflict), resolves it to its own side (the merge's
//! tree is its first parent's) and force-pushes the merge to its attempt branch, as the
//! sandbox driver's merge and history-push scripts do. Landing that is a fast-forward, and
//! the platform holds the local merge exactly (same id and parents).
use super::{Client, Platform, TestResult};
use serde_json::{Value, json};

const TEAM: &str = "attempts/run1/team";

fn check(condition: bool, what: String) -> TestResult {
    if condition { Ok(()) } else { Err(what) }
}

fn head(platform: &Platform, repo: &str, branch: &str) -> TestResult<String> {
    let refs = platform.owner_call("GET", &format!("/repos/{repo}/refs"), None)?;
    refs["refs"][format!("refs/heads/{branch}")]
        .as_str()
        .map(str::to_owned)
        .ok_or(format!("no {branch} in {refs}"))
}

fn land(platform: &Platform, repo: &str, commit: &str) -> TestResult<Value> {
    platform.owner_call(
        "POST",
        &format!("/repos/{repo}/land"),
        Some(json!({ "ref": TEAM, "commit": commit })),
    )
}

/// Runs the flow on `repo` (seeded with README.md), cloned from `url` by `alpha` and `beta`.
pub fn resumed_merge_lands(
    platform: &Platform,
    repo: &str,
    url: &str,
    alpha: &Client,
    beta: &Client,
) -> TestResult {
    let base = head(platform, repo, "main")?;
    land(platform, repo, &base)?;
    let mut dirs = Vec::new();
    for (n, (c, title)) in [(alpha, "Alpha"), (beta, "Beta")].into_iter().enumerate() {
        let out = c.git_output(&c.home, &["clone", "-q", url, "team"])?;
        check(out.status.success(), format!("clone: {out:?}"))?;
        let dir = c.home.join("team");
        c.git(&dir, &["checkout", "-q", "--detach", &base])?;
        c.commit(&dir, title, &[("README.md", &format!("# {title}\n"))])?;
        let to = format!("HEAD:refs/heads/attempts/run1/{}", n + 1);
        c.git(&dir, &["push", "-q", "--force", "origin", &to])?;
        dirs.push(dir);
    }
    land(platform, repo, &head(platform, repo, "attempts/run1/1")?)?;
    let refused = land(platform, repo, &head(platform, repo, "attempts/run1/2")?);
    let refused = refused.err().unwrap_or_default();
    check(
        refused.contains("CONFLICT"),
        format!("Beta conflicts: {refused}"),
    )?;
    let dir = &dirs[1];
    let fetch = format!("+refs/heads/{TEAM}:refs/remotes/origin/{TEAM}");
    beta.git(dir, &["fetch", "-q", "origin", &fetch])?;
    let merging = beta.git_output(dir, &["merge", "-q", "--no-ff", &format!("origin/{TEAM}")])?;
    check(!merging.status.success(), "the merge conflicts".into())?;
    std::fs::write(dir.join("README.md"), "# Beta\n").map_err(|e| e.to_string())?;
    beta.git(dir, &["add", "README.md"])?;
    beta.git(dir, &["-c", "core.editor=true", "merge", "--continue"])?;
    let local = beta.git(dir, &["rev-list", "--parents", "-n", "1", "HEAD"])?;
    beta.git(
        dir,
        &[
            "push",
            "-q",
            "--force",
            "origin",
            "HEAD:refs/heads/attempts/run1/2",
        ],
    )?;
    let pushed = head(platform, repo, "attempts/run1/2")?;
    let shown = platform.owner_call("GET", &format!("/repos/{repo}/commits/{pushed}"), None)?;
    let parents: Vec<&str> = shown["parents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let server = format!("{pushed} {}", parents.join(" "));
    check(server == local, format!("platform {server}, local {local}"))?;
    let landed = land(platform, repo, &pushed)?;
    check(
        head(platform, repo, TEAM)? == pushed,
        format!("a fast-forward to the merge: {landed}"),
    )?;
    let readme = platform.owner_call(
        "GET",
        &format!("/repos/{repo}/blob?ref={TEAM}&path=README.md"),
        None,
    )?;
    check(readme["content"] == "# Beta\n", format!("README: {readme}"))
}
