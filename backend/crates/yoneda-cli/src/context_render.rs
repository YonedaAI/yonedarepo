//! The text of `yoneda context`: the header and landing rules, then open findings, traffic,
//! memories, sessions, open changes and contracts while they fit under the byte cap, then a
//! count of what was left out. Each entry remembers the item it shows, for the hooks' record.
use crate::context_cmd::Local;
use crate::{go_around, traffic};
use serde_json::{Value, json};
use std::fmt::Write;

const SUMMARY_BYTES: usize = 320;
const POLICY_BYTES: usize = 400;

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

/// One section entry: its line and the item it shows (`{type, id}`).
type Entry = (String, Value);

fn item(kind: &str, id: &Value) -> Value {
    json!({ "type": kind, "id": id })
}

/// Open findings, one entry each. Their item is the change: a finding is no item type a
/// platform that has not heard of it would record.
fn findings(read: &Value) -> Vec<Entry> {
    let around = &read["go_around"];
    go_around::entries(around)
        .into_iter()
        .map(|entry| (entry, item("change", &around["change"])))
        .collect()
}

fn memories(read: &Value) -> Vec<Entry> {
    read["memories"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            let line = crate::context_inject::item_line(m);
            (line.trim_end().to_owned(), item("memory", &m["id"]))
        })
        .collect()
}

fn sessions(read: &Value, now: u64) -> Vec<Entry> {
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
            let text = format!(
                "- {} · {}{} · {}{}: {}",
                age(&s["at"], now),
                s["cli"].as_str().unwrap_or("?"),
                model,
                short(&s["commit"]),
                subject,
                line(s["summary"].as_str().unwrap_or_default(), SUMMARY_BYTES)
            );
            (text, item("session", &s["id"]))
        })
        .collect()
}

/// Open changes, the one for `branch` first.
fn changes(read: &Value, branch: Option<&str>) -> Vec<Entry> {
    let mut rows: Vec<&Value> = read["changes"].as_array().into_iter().flatten().collect();
    rows.sort_by_key(|c| c["branch"].as_str() != branch);
    rows.into_iter()
        .map(|c| {
            let mine = if c["branch"].as_str() == branch {
                " (this branch)"
            } else {
                ""
            };
            let text = format!(
                "- #{} {} [branch {} at {}, by {}]{mine}",
                c["number"],
                line(c["title"].as_str().unwrap_or_default(), 120),
                c["branch"].as_str().unwrap_or("?"),
                short(&c["head"]),
                c["author"].as_str().unwrap_or("?")
            );
            (text, item("change", &c["number"]))
        })
        .collect()
}

fn contracts(read: &Value) -> Vec<Entry> {
    read["contracts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let summary = c["contract"]["summary"]
                .as_str()
                .map(|s| line(s, 160))
                .unwrap_or_else(|| line(&c["contract"].to_string(), 160));
            let text = format!(
                "- {} `{}`: {summary} (at {})",
                c["path"].as_str().unwrap_or("?"),
                c["symbol_path"].as_str().unwrap_or("?"),
                short(&c["commit"])
            );
            (text, item("contract", &c["seq"]))
        })
        .collect()
}

const RULES: &str = "- Push with plain `git push` (or `yoneda push`): the files you read are declared with it, and the platform refuses the push if one changed meanwhile or your change conflicts. On a refusal, `git pull --rebase`, re-check the named paths, then push again; never force-push main.\n- Before ending, make sure your commits are pushed; this session's summary is recorded on them.\n- Leave what the code does not say (a decision, constraint or non-obvious fix) for later sessions: `yoneda memory add` or git_memory_add.";

/// The context text and the items it carries.
pub struct Rendered {
    pub text: String,
    pub items: Vec<Value>,
}

/// The context text, at most `max` bytes.
pub fn render(read: &Value, local: &Local, max: usize, now: u64) -> String {
    render_items(read, local, max, now).text
}

/// The context text, at most `max` bytes: the header and rules, then open findings, traffic,
/// memories, sessions, open changes and contracts while they fit, then a count of what was left
/// out.
pub fn render_items(read: &Value, local: &Local, max: usize, now: u64) -> Rendered {
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
    let around = go_around::title(&read["go_around"]);
    let sections = [
        (around.as_str(), findings(read)),
        (traffic::TITLE, traffic::entries(&read["traffic"])),
        (
            "Memories (decisions, constraints, gotchas, how-tos) on the files you are changing, then the newest",
            memories(read),
        ),
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
    let mut items = Vec::new();
    for (title, lines) in sections {
        if lines.is_empty() {
            continue;
        }
        let heading = format!("\n## {title}\n");
        if out.len() + heading.len() + lines[0].0.len() + 1 > budget {
            omitted += lines.len();
            continue;
        }
        out.push_str(&heading);
        for (entry, shown) in lines {
            if out.len() + entry.len() + 1 > budget {
                omitted += 1;
            } else {
                out.push_str(&entry);
                out.push('\n');
                if !items.contains(&shown) {
                    items.push(shown);
                }
            }
        }
    }
    if omitted > 0 {
        let _ = writeln!(
            out,
            "\n({omitted} more entries left out to stay under {} bytes: `yoneda context --json`, or the MCP tools git_context_relevant and git_memory_list.)",
            max
        );
    }
    if out.len() > max {
        out = crate::agent_hook::truncate(&out, max.saturating_sub(3));
    }
    Rendered { text: out, items }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_cmd::DEFAULT_BYTES;

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
            "contracts": [{"seq": 4, "path": "src/net.rs", "symbol_path": "retry",
                "commit": "d".repeat(40), "contract": {"summary": "Retries."}}],
            "memories": [{"type": "memory", "id": 9, "stale": false,
                "text": "retry() must stay idempotent.",
                "memory": {"kind": "gotcha", "anchors": [{"path": "src/net.rs", "symbol_path": "retry"}]}}],
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
        assert!(text.contains("- [gotcha] retry() must stay idempotent. (src/net.rs#retry) #9"));
        // Memories lead, before the sessions.
        assert!(text.find("[gotcha]").unwrap() < text.find("Session 0").unwrap());
        let items = render_items(&read(3), &local, DEFAULT_BYTES, NOW).items;
        assert_eq!(items[0], json!({"type": "memory", "id": 9}));
        assert_eq!(items.len(), 1 + 3 + 2 + 1);
        assert!(items.contains(&json!({"type": "contract", "id": 4})));
        assert!(items.contains(&json!({"type": "change", "id": 3})));
        // Summaries are one line and capped.
        let line = text.lines().find(|l| l.contains("Session 0")).unwrap();
        assert!(line.len() < SUMMARY_BYTES + 120);
        assert!(!text.contains("more entries left out"));
    }

    #[test]
    fn stays_under_the_cap_and_counts_what_it_left_out() {
        let local = Local::default();
        for max in [800, 1500, 3000] {
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

    fn around(n: u64) -> Value {
        json!({ "change": 3, "open": n, "findings": (1..=n.min(10)).map(|line| json!({
            "id": line, "commit": "b".repeat(40), "path": "src/net.rs", "line": line,
            "side": "new", "body": "**High: off by one**\n\nThe loop stops early.",
            "principal": "token:agents", "on_head": line != 2 })).collect::<Vec<_>>() })
    }

    #[test]
    fn open_findings_lead_with_file_and_line() {
        let local = Local {
            brief: None,
            branch: Some("fix".into()),
        };
        let mut packet = read(1);
        packet["go_around"] = around(2);
        let done = render_items(&packet, &local, DEFAULT_BYTES, NOW);
        assert!(
            done.text
                .contains("Go-around: 2 open findings on change #3")
        );
        assert!(
            done.text
                .contains("- src/net.rs:1: **High: off by one** The loop stops early.\n")
        );
        assert!(done.text.contains(
            "src/net.rs:2: **High: off by one** The loop stops early. (on older commit bbbbbbb)"
        ));
        assert!(done.text.find("Go-around").unwrap() < done.text.find("[gotcha]").unwrap());
        // The change is one item, however many of its findings show; old platforms know it.
        let change = json!({"type": "change", "id": 3});
        assert_eq!(done.items.iter().filter(|i| **i == change).count(), 1);
        assert_eq!(done.items[0], change);
    }

    fn traffic(n: i64) -> Value {
        json!({ "more": 2, "warnings": (1..=n).map(|landing| json!({
            "landing": landing, "overlap": "symbol", "path": "src/net.rs", "symbols": ["retry"],
            "title": "Retry budget", "branch": "fix", "author": "token:a" })).collect::<Vec<_>>() })
    }

    #[test]
    fn traffic_follows_findings_and_leads_the_rest() {
        let local = Local {
            brief: None,
            branch: Some("fix".into()),
        };
        let mut packet = read(1);
        packet["go_around"] = around(1);
        packet["traffic"] = traffic(1);
        let done = render_items(&packet, &local, DEFAULT_BYTES, NOW);
        let warning = done
            .text
            .find("- Landing 1 (\"Retry budget\", branch fix) is changing `retry` in src/net.rs")
            .unwrap();
        assert!(done.text.find("Go-around").unwrap() < warning);
        assert!(warning < done.text.find("[gotcha]").unwrap());
        assert!(done.text.contains("- and 2 more on these files\n"));
        let told = json!({"type": "traffic", "id": 1, "path": "src/net.rs"});
        assert_eq!(done.items.iter().filter(|i| **i == told).count(), 1);
    }

    #[test]
    fn traffic_stays_inside_the_cap() {
        let mut packet = read(20);
        packet["traffic"] = traffic(8);
        for max in [800, 1500, DEFAULT_BYTES] {
            let text = render(&packet, &Local::default(), max, NOW);
            assert!(text.len() <= max, "{} > {max}", text.len());
        }
        // The answer of a platform without it renders as before.
        let plain = render(&read(1), &Local::default(), DEFAULT_BYTES, NOW);
        assert!(!plain.contains("Traffic"));
    }

    #[test]
    fn no_findings_add_nothing_and_the_cap_still_holds() {
        let local = Local::default();
        let mut packet = read(3);
        assert!(!render(&packet, &local, DEFAULT_BYTES, NOW).contains("Go-around"));
        packet["go_around"] = around(0);
        assert!(!render(&packet, &local, DEFAULT_BYTES, NOW).contains("Go-around"));
        packet["go_around"] = around(40);
        for max in [800, 1500, DEFAULT_BYTES] {
            let text = render(&packet, &local, max, NOW);
            assert!(text.len() <= max, "{} > {max}", text.len());
        }
        let text = render(&packet, &local, DEFAULT_BYTES, NOW);
        assert!(text.contains("and 30 more: yoneda change show 3"));
    }
}
