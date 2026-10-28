//! `yoneda context`: what a coding session starting in this clone should know, as compact
//! text for the agent (the session-start hooks inject it). One platform read
//! (`GET /context`) gives main's and the branch's heads, the landing rules, the newest
//! session records, open changes and the contracts on the paths this clone is changing;
//! the local status line says what is not pushed yet. The text is capped (6 KiB by
//! default): sections fill in order and whatever does not fit is counted, not cut mid-line.
use crate::command::Target;
use crate::error::{Error, Result};
use crate::target::{self, Clone};
use serde_json::Value;
use std::fmt::Write;
use std::time::Duration;

pub const DEFAULT_BYTES: usize = 6 * 1024;
const SESSIONS: u64 = 8;
const CHANGES: u64 = 10;
const CONTRACTS: u64 = 5;
const SUMMARY_BYTES: usize = 320;
const POLICY_BYTES: usize = 400;
const MAX_PATHS: usize = 100;
/// A session start waits at most this long for the platform.
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// What this clone knows locally: its status line and branch.
#[derive(Debug, Default)]
pub struct Local {
    pub brief: Option<String>,
    pub branch: Option<String>,
}

/// The files this clone is changing: uncommitted, and committed since main on the remote.
fn changing(clone: &Clone) -> Vec<String> {
    let mut paths = clone
        .git
        .run(&["diff", "--name-only", "HEAD"])
        .unwrap_or_default();
    if let Some(remote) = &clone.remote_name {
        let range = format!("refs/remotes/{remote}/main...HEAD");
        paths.push('\n');
        paths.push_str(
            &clone
                .git
                .run(&["diff", "--name-only", &range])
                .unwrap_or_default(),
        );
    }
    let mut out: Vec<String> = paths
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty() && !p.contains(','))
        .map(str::to_owned)
        .collect();
    out.sort();
    out.dedup();
    out.truncate(MAX_PATHS);
    out
}

fn query(local: &Local, paths: &[String]) -> String {
    let mut q = format!("/context?sessions={SESSIONS}&changes={CHANGES}&contracts={CONTRACTS}");
    if let Some(branch) = &local.branch {
        let _ = write!(q, "&branch={}", encode(branch));
    }
    if !paths.is_empty() {
        let _ = write!(q, "&paths={}", encode(&paths.join(",")));
    }
    q
}

/// Percent-encodes everything but unreserved characters, `/` and `,`.
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b',' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The context of the clone at the current directory: local facts and the platform's read.
pub async fn gather() -> Result<(Local, Value)> {
    let resolved = target::resolve(&Target::default())?;
    let clone = resolved
        .clone
        .ok_or_else(|| Error::usage("run this inside a clone with a YonedaRepo remote"))?;
    let local = Local {
        brief: crate::brief::line(&clone).ok(),
        branch: clone
            .git
            .run(&["symbolic-ref", "--short", "HEAD"])
            .ok()
            .filter(|b| !b.is_empty()),
    };
    let path = query(&local, &changing(&clone));
    let read = tokio::time::timeout(FETCH_TIMEOUT, resolved.api.get(&path))
        .await
        .map_err(|_| Error::new("the platform did not answer within 8 s"))??;
    Ok((local, read))
}

/// `yoneda context [--max-bytes n] [--json]`.
pub async fn run(max_bytes: usize, json: bool) -> Result<()> {
    let (local, read) = gather().await?;
    if json {
        println!("{read}");
    } else {
        println!("{}", render(&read, &local, max_bytes, now_ms()));
    }
    Ok(())
}

/// The context text for a session-start hook; a failure becomes one line saying so.
pub async fn for_hook(max_bytes: usize) -> String {
    match gather().await {
        Ok((local, read)) => render(&read, &local, max_bytes, now_ms()),
        Err(e) => format!(
            "YonedaRepo: this clone's repository context is unavailable ({e}); `yoneda context` retries."
        ),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

fn short(sha: &Value) -> String {
    sha.as_str()
        .map_or_else(|| "-".into(), |s| s.chars().take(7).collect())
}

/// One line: whitespace runs folded, cut to `max` bytes on a character boundary.
fn line(text: &str, max: usize) -> String {
    let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::agent_hook::truncate(&folded, max)
}

fn age(at: &Value, now: u64) -> String {
    let Some(at) = at.as_u64() else {
        return "?".into();
    };
    let minutes = now.saturating_sub(at) / 60_000;
    match minutes {
        0 => "just now".into(),
        1..=59 => format!("{minutes}m ago"),
        60..=2879 => format!("{}h ago", minutes / 60),
        _ => format!("{}d ago", minutes / 1440),
    }
}

fn policy(p: &Value) -> String {
    let checks: Vec<&str> = p["required_checks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let mut out = format!(
        "approvals required: {}; required checks: {}",
        p["approvals"].as_u64().unwrap_or(0),
        if checks.is_empty() {
            "none".into()
        } else {
            checks.join(", ")
        }
    );
    if let Some(auto) = p["auto_approve"].as_array().filter(|a| !a.is_empty()) {
        let classes: Vec<&str> = auto.iter().filter_map(Value::as_str).collect();
        let _ = write!(out, "; auto-approved: {}", classes.join(", "));
    }
    line(&out, POLICY_BYTES)
}

fn sessions(read: &Value, now: u64) -> Vec<String> {
    read["sessions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let model = s["model"]
                .as_str()
                .map(|m| format!(" {m}"))
                .unwrap_or_default();
            let subject = s["subject"]
                .as_str()
                .map(|t| format!(" \"{}\"", line(t, 80)))
                .unwrap_or_default();
            format!(
                "- {} · {}{} · {}{}: {}",
                age(&s["at"], now),
                s["cli"].as_str().unwrap_or("?"),
                model,
                short(&s["commit"]),
                subject,
                line(s["summary"].as_str().unwrap_or_default(), SUMMARY_BYTES)
            )
        })
        .collect()
}

/// Open changes, the one for `branch` first.
fn changes(read: &Value, branch: Option<&str>) -> Vec<String> {
    let mut rows: Vec<&Value> = read["changes"].as_array().into_iter().flatten().collect();
    rows.sort_by_key(|c| c["branch"].as_str() != branch);
    rows.into_iter()
        .map(|c| {
            let mine = if c["branch"].as_str() == branch {
                " (this branch)"
            } else {
                ""
            };
            format!(
                "- #{} {} [branch {} at {}, by {}]{mine}",
                c["number"],
                line(c["title"].as_str().unwrap_or_default(), 120),
                c["branch"].as_str().unwrap_or("?"),
                short(&c["head"]),
                c["author"].as_str().unwrap_or("?")
            )
        })
        .collect()
}

fn contracts(read: &Value) -> Vec<String> {
    read["contracts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let summary = c["contract"]["summary"]
                .as_str()
                .map(|s| line(s, 160))
                .unwrap_or_else(|| line(&c["contract"].to_string(), 160));
            format!(
                "- {} `{}`: {summary} (at {})",
                c["path"].as_str().unwrap_or("?"),
                c["symbol_path"].as_str().unwrap_or("?"),
                short(&c["commit"])
            )
        })
        .collect()
}

const RULES: &str = "- Push with plain `git push` (or `yoneda push`): the files you read are declared with it, and the platform refuses the push if one changed meanwhile or your change conflicts. On a refusal, `git pull --rebase`, re-check the named paths, then push again; never force-push main.\n- Before ending, make sure your commits are pushed; this session's summary is recorded on them.";

/// The context text, at most `max` bytes: the header and rules, then sessions, open changes
/// and contracts while they fit, then a count of what was left out.
pub fn render(read: &Value, local: &Local, max: usize, now: u64) -> String {
    let mut out = String::from("# YonedaRepo context for this clone\n");
    if let Some(brief) = &local.brief {
        let _ = writeln!(out, "{}", line(brief, 300));
    }
    let _ = write!(
        out,
        "main at {} (log version {})",
        short(&read["main"]),
        read["version"]
    );
    if let Some(name) = read["branch"]["name"].as_str().filter(|b| *b != "main") {
        let _ = write!(out, "; branch {name} at {}", short(&read["branch"]["head"]));
    }
    let _ = write!(
        out,
        ".\n\n## Landing rules\n- {}\n{RULES}\n",
        policy(&read["policy"])
    );
    let sections = [
        ("Recent sessions (newest first)", sessions(read, now)),
        (
            "Open change requests",
            changes(read, local.branch.as_deref()),
        ),
        (
            "Contracts on the files you are changing, then the newest",
            contracts(read),
        ),
    ];
    // Room kept for the omission note.
    let budget = max.saturating_sub(160);
    let mut omitted = 0;
    for (title, lines) in sections {
        if lines.is_empty() {
            continue;
        }
        let heading = format!("\n## {title}\n");
        if out.len() + heading.len() + lines[0].len() + 1 > budget {
            omitted += lines.len();
            continue;
        }
        out.push_str(&heading);
        for entry in lines {
            if out.len() + entry.len() + 1 > budget {
                omitted += 1;
            } else {
                out.push_str(&entry);
                out.push('\n');
            }
        }
    }
    if omitted > 0 {
        let _ = writeln!(
            out,
            "\n({omitted} more entries left out to stay under {} bytes: `yoneda context --json`, or the MCP tools git_sessions_recent and git_context.)",
            max
        );
    }
    if out.len() > max {
        out = crate::agent_hook::truncate(&out, max.saturating_sub(3));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NOW: u64 = 1_800_000_000_000;

    fn read(sessions: usize) -> Value {
        json!({
            "version": 42, "main": "a".repeat(40),
            "branch": {"name": "fix", "head": "b".repeat(40)},
            "policy": {"approvals": 1, "required_checks": ["unit"], "auto_approve": ["docs"]},
            "sessions": (0..sessions).map(|n| json!({
                "id": 100 - n, "commit": format!("{n:040}"), "subject": format!("step {n}"),
                "cli": "opencode", "model": "zai-coding-plan/glm-5.3",
                "summary": format!("Session {n} did\nthings. {}", "x".repeat(400)),
                "at": NOW - (n as u64) * 3_600_000 })).collect::<Vec<_>>(),
            "changes": [
                {"number": 2, "title": "Other", "branch": "other", "head": "c".repeat(40), "author": "token:b"},
                {"number": 3, "title": "Retry", "branch": "fix", "head": "b".repeat(40), "author": "token:a"}],
            "contracts": [{"path": "src/net.rs", "symbol_path": "retry",
                "commit": "d".repeat(40), "contract": {"summary": "Retries."}}],
        })
    }

    #[test]
    fn renders_sessions_newest_first_then_changes_and_contracts() {
        let local = Local {
            brief: Some("yoneda r1 at https://x | fix: 1 commit(s) not on the platform".into()),
            branch: Some("fix".into()),
        };
        let text = render(&read(3), &local, DEFAULT_BYTES, NOW);
        assert!(text.contains("main at aaaaaaa (log version 42); branch fix at bbbbbbb."));
        assert!(text.contains("approvals required: 1; required checks: unit; auto-approved: docs"));
        let first = text.find("Session 0 did things.").unwrap();
        let second = text.find("Session 1 did things.").unwrap();
        assert!(first < second, "newest first");
        assert!(
            text.contains("- just now · opencode zai-coding-plan/glm-5.3 · 0000000 \"step 0\"")
        );
        assert!(text.contains("1h ago"));
        // The change for this clone's branch leads.
        assert!(text.find("#3 Retry").unwrap() < text.find("#2 Other").unwrap());
        assert!(text.contains("(this branch)"));
        assert!(text.contains("- src/net.rs `retry`: Retries. (at ddddddd)"));
        // Summaries are one line and capped.
        let line = text.lines().find(|l| l.contains("Session 0")).unwrap();
        assert!(line.len() < SUMMARY_BYTES + 120);
        assert!(!text.contains("more entries left out"));
    }

    #[test]
    fn stays_under_the_cap_and_counts_what_it_left_out() {
        let local = Local::default();
        for max in [600, 1500, 3000] {
            let text = render(&read(20), &local, max, NOW);
            assert!(text.len() <= max, "{} > {max}", text.len());
            assert!(text.contains("## Landing rules"));
            assert!(text.contains("more entries left out"), "{max}");
        }
        let roomy = render(&read(20), &local, 64 * 1024, NOW);
        assert_eq!(roomy.matches("· opencode").count(), 20);
        // A tiny cap still yields valid text within it.
        assert!(render(&read(2), &local, 100, NOW).len() <= 100);
    }

    #[test]
    fn asks_for_the_branch_and_the_changed_paths() {
        let local = Local {
            brief: None,
            branch: Some("feat/x y".into()),
        };
        assert_eq!(
            query(&local, &["src/a.rs".into(), "b c.rs".into()]),
            "/context?sessions=8&changes=10&contracts=5&branch=feat/x%20y&paths=src/a.rs,b%20c.rs"
        );
        assert_eq!(
            query(&Local::default(), &[]),
            "/context?sessions=8&changes=10&contracts=5"
        );
    }
}
