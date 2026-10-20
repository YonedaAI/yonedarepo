//! Offline work synced through a local platform under workerd. One platform serves every
//! scenario (each on its own repository) because starting workerd dominates the runtime.
//! Run with `cargo test -p yoneda-cli -- --include-ignored`; it needs the workspace's
//! node modules (wrangler) and the Rust Wasm worker build, but no provider keys.
mod support;

use serde_json::Value;
use std::path::{Path, PathBuf};
use support::{Client, Platform, TestResult};

const LINES: &str = "l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";

fn edit_line(line: usize, text: &str) -> String {
    LINES
        .lines()
        .enumerate()
        .map(|(i, l)| {
            if i == line {
                format!("{text}\n")
            } else {
                format!("{l}\n")
            }
        })
        .collect()
}

fn content(value: &Value) -> String {
    value["content"].as_str().unwrap_or_default().to_owned()
}

fn state(dir: &Path) -> TestResult<Value> {
    let raw = std::fs::read(dir.join(".yoneda/state.json")).map_err(|e| e.to_string())?;
    serde_json::from_slice(&raw).map_err(|e| e.to_string())
}

fn check(condition: bool, what: &str) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(what.to_owned())
    }
}

struct Scenario<'a> {
    platform: &'a Platform,
    client: Client,
    repo: String,
    dir: PathBuf,
}

impl<'a> Scenario<'a> {
    fn new(platform: &'a Platform, name: &str, files: &[(&str, &str)]) -> TestResult<Self> {
        let (repo, token) = platform.repo(files)?;
        let home = platform.scratch.path().join(format!("home-{name}"));
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        let client = Client {
            home: home.clone(),
            token,
        };
        let out = client.ok(
            &home,
            &["clone", &repo, "work", "--origin", &platform.origin],
        )?;
        check(
            out.contains("API snapshot"),
            "an R2-backed repository clones through the API",
        )?;
        Ok(Self {
            platform,
            client,
            repo,
            dir: home.join("work"),
        })
    }

    /// The local HEAD tree equals main's latest tree on the platform.
    fn in_step(&self) -> TestResult {
        let (_, _, tree) = self.platform.main(&self.repo)?;
        check(
            self.client.git(&self.dir, &["rev-parse", "HEAD^{tree}"])? == tree,
            "local tree matches main",
        )
    }
}

fn three_offline_commits_land(platform: &Platform) -> TestResult {
    let s = Scenario::new(platform, "series", &[("a.txt", "a\n")])?;
    s.client
        .commit(&s.dir, "notes", &[("notes/ünïcødé dir/n.md", "naïve\n")])?;
    s.client.commit(&s.dir, "edit a", &[("a.txt", "a2\n")])?;
    std::fs::rename(s.dir.join("notes"), s.dir.join("docs")).map_err(|e| e.to_string())?;
    s.client.commit(
        &s.dir,
        "tool and rename",
        &[("tool.sh", "#!/bin/sh\necho hi\n")],
    )?;
    s.client
        .git(&s.dir, &["update-index", "--chmod=+x", "tool.sh"])?;
    s.client
        .git(&s.dir, &["commit", "-q", "--amend", "--no-edit"])?;
    let status = s.client.ok(&s.dir, &["status"])?;
    check(
        status.contains("pending 3 local commit(s): 0 pushed"),
        &format!("status before sync:\n{status}"),
    )?;
    let out = s.client.ok(&s.dir, &["sync", "--land"])?;
    check(
        out.contains("Pushed 3 platform commit(s)") && out.contains("Landed 3 commit(s)"),
        &out,
    )?;
    // The chain's tip lands as one fast-forward: one log version on main, not three.
    let log = platform.owner_call("GET", &format!("/repos/{}/txlog", s.repo), None)?;
    let on_main: Vec<&Value> = log["entries"]
        .as_array()
        .ok_or("txlog has no entries")?
        .iter()
        .filter(|e| e["refname"] == "refs/heads/main" && e["kind"] != "import")
        .collect();
    check(
        // a.txt, the renamed note and tool.sh; the note's first path came and went.
        on_main.len() == 1 && on_main[0]["paths"].as_array().map(Vec::len) == Some(3),
        &format!("one landing carrying the chain's net changes, got {on_main:?}"),
    )?;
    check(
        content(&platform.blob(&s.repo, "a.txt")?) == "a2\n",
        "a.txt landed",
    )?;
    check(
        content(&platform.blob(&s.repo, "docs/%C3%BCn%C3%AFc%C3%B8d%C3%A9%20dir/n.md")?)
            == "naïve\n",
        "unicode rename",
    )?;
    check(
        platform
            .blob(&s.repo, "notes/%C3%BCn%C3%AFc%C3%B8d%C3%A9%20dir/n.md")
            .is_err(),
        "old path deleted",
    )?;
    check(
        platform.blob(&s.repo, "tool.sh")?["executable"] == true,
        "exec bit landed",
    )?;
    s.in_step()?;
    let status = s.client.ok(&s.dir, &["status"])?;
    check(
        status.contains("pending 0 local commit(s)")
            && status.contains("landed  last at version")
            && status.contains("0 landed changeset(s) await"),
        &status,
    )
}

fn disjoint_writer_still_lands(platform: &Platform) -> TestResult {
    let s = Scenario::new(platform, "disjoint", &[("a.txt", "a\n"), ("b.txt", "b\n")])?;
    s.client.commit(&s.dir, "edit a", &[("a.txt", "mine\n")])?;
    platform.other_writer(&s.repo, &[("b.txt", "theirs\n")])?;
    s.client.ok(&s.dir, &["sync", "--land"])?;
    check(
        content(&platform.blob(&s.repo, "a.txt")?) == "mine\n",
        "my change landed",
    )?;
    check(
        content(&platform.blob(&s.repo, "b.txt")?) == "theirs\n",
        "their change kept",
    )?;
    // The checkout fast-forwarded onto main, other writer's file included.
    let b = std::fs::read_to_string(s.dir.join("b.txt")).map_err(|e| e.to_string())?;
    check(b == "theirs\n", "local b.txt updated")?;
    s.in_step()
}

fn same_file_regions_merge_and_same_lines_conflict(platform: &Platform) -> TestResult {
    let s = Scenario::new(platform, "regions", &[("f.txt", LINES)])?;
    s.client.commit(
        &s.dir,
        "edit last line",
        &[("f.txt", &edit_line(8, "mine"))],
    )?;
    platform.other_writer(&s.repo, &[("f.txt", &edit_line(0, "theirs"))])?;
    s.client.ok(&s.dir, &["sync", "--land"])?;
    let merged = content(&platform.blob(&s.repo, "f.txt")?);
    check(
        merged.starts_with("theirs\n") && merged.ends_with("mine\n"),
        &format!("merged: {merged:?}"),
    )?;
    s.in_step()?;

    let before = std::fs::read_to_string(s.dir.join("f.txt")).map_err(|e| e.to_string())?;
    let line4 = |text: &str| before.replace("l4\n", &format!("{text}\n"));
    s.client
        .commit(&s.dir, "edit line 4", &[("f.txt", &line4("ours"))])?;
    platform.other_writer(&s.repo, &[("f.txt", &line4("theirs4"))])?;
    let out = s.client.yoneda(&s.dir, &["sync", "--land"])?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    check(
        out.status.code() == Some(2),
        &format!("conflict exits 2: {stderr}"),
    )?;
    check(
        stderr.contains("f.txt"),
        &format!("names the file: {stderr}"),
    )?;
    let side = |suffix: &str| {
        std::fs::read_to_string(s.dir.join(format!(".yoneda/conflicts/f.txt.{suffix}")))
    };
    check(side("base").ok() == Some(before.clone()), "base side")?;
    check(side("ours").ok() == Some(line4("ours")), "ours side")?;
    check(side("theirs").ok() == Some(line4("theirs4")), "theirs side")
}

fn pull_rebases_pending_work(platform: &Platform) -> TestResult {
    let s = Scenario::new(platform, "pull", &[("a.txt", "a\n")])?;
    let base_version = state(&s.dir)?["base_version"].as_u64();
    s.client.commit(&s.dir, "add h", &[("h.txt", "h\n")])?;
    platform.other_writer(&s.repo, &[("g.txt", "g\n")])?;
    let out = s.client.ok(&s.dir, &["pull"])?;
    check(out.contains("Rebased 1 pending commit(s)"), &out)?;
    check(
        s.dir.join("g.txt").exists() && s.dir.join("h.txt").exists(),
        "both files present",
    )?;
    let (version, main, tree) = platform.main(&s.repo)?;
    let pinned = state(&s.dir)?;
    check(
        pinned["base_version"].as_u64() == Some(version) && Some(version) > base_version,
        "base advanced",
    )?;
    check(
        pinned["base_commit"] == main.as_str(),
        "base commit is main",
    )?;
    check(
        s.client.git(&s.dir, &["rev-parse", "HEAD~1^{tree}"])? == tree,
        "rebased onto main's tree",
    )?;
    s.client.ok(&s.dir, &["sync", "--land"])?;
    check(
        content(&platform.blob(&s.repo, "h.txt")?) == "h\n",
        "rebased work lands",
    )?;
    s.in_step()
}

fn resync_after_a_lost_ack_adopts_instead_of_duplicating(platform: &Platform) -> TestResult {
    let s = Scenario::new(platform, "lostack", &[("a.txt", "a\n")])?;
    let before = state(&s.dir)?;
    let local = s.client.commit(&s.dir, "edit", &[("a.txt", "edited\n")])?;
    s.client.ok(&s.dir, &["sync"])?;
    let (version, _, _) = platform.main(&s.repo)?;
    let pushed = state(&s.dir)?;
    // Simulate the acknowledgment lost after the branch moved: the old state comes back.
    let path = s.dir.join(".yoneda/state.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&before).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let out = s.client.ok(&s.dir, &["sync"])?;
    check(out.contains("Adopted 1 commit(s)"), &out)?;
    let (after, _, _) = platform.main(&s.repo)?;
    check(after == version, "no new commit or branch move")?;
    let resynced = state(&s.dir)?;
    check(
        resynced["platform"][&local] == pushed["platform"][&local],
        "same platform commit",
    )?;
    s.client.ok(&s.dir, &["sync", "--land"])?;
    check(
        content(&platform.blob(&s.repo, "a.txt")?) == "edited\n",
        "lands once",
    )
}

#[test]
#[ignore = "starts the local platform under workerd: cargo test -p yoneda-cli -- --include-ignored"]
fn offline_work_syncs_through_the_local_platform() -> TestResult {
    let platform = Platform::start()?;
    three_offline_commits_land(&platform).map_err(|e| format!("series: {e}"))?;
    disjoint_writer_still_lands(&platform).map_err(|e| format!("disjoint: {e}"))?;
    same_file_regions_merge_and_same_lines_conflict(&platform)
        .map_err(|e| format!("regions: {e}"))?;
    pull_rebases_pending_work(&platform).map_err(|e| format!("pull: {e}"))?;
    resync_after_a_lost_ack_adopts_instead_of_duplicating(&platform)
        .map_err(|e| format!("lost ack: {e}"))
}
