//! Server-side reads with no checkout: log, grep, blame, diff and symbols, optionally at
//! an earlier log version (`--at`, time travel on the transaction log).
use crate::api::encode;
use crate::command::ReadCommand;
use crate::error::Result;
use crate::human;
use crate::output::{self, DiffEntry, GrepFile, GrepLine, LogEntry, Search, SearchGroup};
use crate::target::Resolved;
use serde_json::Value;

/// `?a=1&b=2` from the parameters that are set.
pub fn query(params: &[(&str, Option<String>)]) -> String {
    let set: Vec<String> = params
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| format!("{k}={}", encode(v))))
        .collect();
    if set.is_empty() {
        String::new()
    } else {
        format!("?{}", set.join("&"))
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or_default()
}

fn print_json(value: &Value) {
    human!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    );
}

/// One line per search hit: `path:line: text` where the platform names them.
fn print_hits(found: &Value) -> Vec<GrepFile> {
    let mut files = Vec::new();
    for result in found["results"].as_array().into_iter().flatten() {
        let path = result["path"].as_str().unwrap_or("?");
        let lines = result["lines"].as_array().cloned().unwrap_or_default();
        if lines.is_empty() {
            human!("{path}");
        }
        let mut hits = Vec::new();
        for line in lines {
            let number = line["line"].as_u64().or_else(|| line["number"].as_u64());
            let text = line["text"].as_str().or_else(|| line.as_str());
            match (number, text) {
                (Some(n), Some(t)) => human!("{path}:{n}: {t}"),
                _ => human!("{path}: {line}"),
            }
            hits.push(GrepLine {
                line: number,
                text: text.map(str::to_owned),
            });
        }
        files.push(GrepFile {
            path: path.to_owned(),
            lines: hits,
        });
    }
    files
}

/// A record group of a search answer (null: not asked for, or not readable by this token).
fn search_group<T: serde::de::DeserializeOwned>(
    found: &Value,
    key: &str,
) -> Result<Option<SearchGroup<T>>> {
    if found[key].is_null() {
        return Ok(None);
    }
    serde_json::from_value(found[key].clone())
        .map(Some)
        .map_err(|e| crate::error::Error::new(format!("the platform's {key} group: {e}")))
}

/// Prints a search answer group by group; returns its `--json` report.
fn print_search(found: &Value) -> Result<Search> {
    let groups: Vec<String> = found["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g.as_str().map(str::to_owned))
        .collect();
    let mut report = Search {
        query: found["query"].as_str().unwrap_or_default().to_owned(),
        code: Vec::new(),
        memories: found["memories"].as_array().cloned(),
        commits: search_group(found, "commits")?,
        sessions: search_group(found, "sessions")?,
        changes: search_group(found, "changes")?,
        groups,
    };
    if report.groups.iter().any(|g| g == "code") {
        human!("code");
        report.code = print_hits(found);
    }
    if let Some(memories) = &report.memories {
        human!("memories ({})", memories.len());
        for m in memories {
            human!(
                "  #{} {}",
                m["id"],
                first_line(m["text"].as_str().unwrap_or_default())
            );
        }
    }
    if let Some(commits) = &report.commits {
        human!("commits ({})", commits.count);
        for c in &commits.results {
            let short = c.commit.get(..12).unwrap_or(&c.commit);
            human!("  {short} {} ({})", c.subject, c.principal);
        }
    }
    if let Some(sessions) = &report.sessions {
        human!("sessions ({})", sessions.count);
        for s in &sessions.results {
            let short = s.commit.get(..12).unwrap_or(&s.commit);
            human!(
                "  #{} {} on {short}: {}",
                s.id,
                s.cli,
                first_line(&s.summary)
            );
        }
    }
    if let Some(changes) = &report.changes {
        human!("changes ({})", changes.count);
        for c in &changes.results {
            human!("  #{} [{}] {}", c.number, c.status, c.title);
        }
    }
    Ok(report)
}

pub async fn read(t: &Resolved, command: ReadCommand) -> Result<()> {
    let at = |v: Option<u64>| v.map(|v| v.to_string());
    match command {
        ReadCommand::Log {
            path,
            branch,
            limit,
            at: version,
        } => {
            let q = query(&[
                ("ref", branch),
                ("path", path),
                ("limit", limit.map(|l| l.to_string())),
                ("at", at(version)),
            ]);
            let log = t.api.get(&format!("/log{q}")).await?;
            let mut commits = Vec::new();
            for commit in log["commits"].as_array().into_iter().flatten() {
                let version = commit["landed"]["version"].as_u64();
                let landed = version.map(|v| format!("v{v} ")).unwrap_or_default();
                let message = commit["message"].as_str().unwrap_or_default();
                human!(
                    "{} {landed}{}",
                    commit["commit"].as_str().unwrap_or("?"),
                    first_line(message)
                );
                commits.push(LogEntry {
                    commit: commit["commit"].as_str().unwrap_or_default().to_owned(),
                    version,
                    message: message.to_owned(),
                });
            }
            output::emit(&output::Log { commits });
        }
        ReadCommand::Grep {
            query: needle,
            path,
            ignore_case,
            at: version,
        } => {
            let q = query(&[
                ("query", Some(needle)),
                ("path", path),
                ("ignore_case", ignore_case.then(|| "true".to_owned())),
                ("at", at(version)),
            ]);
            let results = print_hits(&t.api.get(&format!("/search{q}")).await?);
            output::emit(&output::Grep { results });
        }
        ReadCommand::Search {
            query: needle,
            groups,
            path,
            branch,
            limit,
            at: version,
        } => {
            let q = query(&[
                ("query", Some(needle)),
                ("groups", groups.map(|g| g.join(","))),
                ("path", path),
                ("ref", branch),
                ("limit", limit.map(|l| l.to_string())),
                ("at", at(version)),
            ]);
            let found = t.api.get(&format!("/search{q}")).await?;
            output::emit(&print_search(&found)?);
        }
        ReadCommand::Blame {
            path,
            branch,
            at: version,
        } => {
            let q = query(&[("path", Some(path)), ("ref", branch), ("at", at(version))]);
            let blame = t.api.get(&format!("/blame{q}")).await?;
            print_json(&blame);
            output::emit(&output::Blame { blame });
        }
        ReadCommand::Diff {
            base,
            head,
            path,
            at: version,
        } => {
            let q = query(&[
                ("base", base),
                ("head", head),
                ("path", path),
                ("at", at(version)),
                ("patch", Some("true".into())),
            ]);
            let diff = t.api.get(&format!("/diff{q}")).await?;
            let mut changes = Vec::new();
            for change in diff["changes"].as_array().into_iter().flatten() {
                let status = change["status"].as_str().unwrap_or("M");
                let patch = change["patch"].as_str();
                match patch {
                    Some(patch) if !output::json() => print!("{patch}"),
                    Some(_) => {}
                    None => human!("{status} {}", change["path"].as_str().unwrap_or("?")),
                }
                changes.push(DiffEntry {
                    path: change["path"].as_str().unwrap_or_default().to_owned(),
                    status: status.to_owned(),
                    patch: patch.map(str::to_owned),
                });
            }
            output::emit(&output::Diff { changes });
        }
        ReadCommand::Symbols { path, at: version } => {
            let q = query(&[("path", Some(path)), ("at", at(version))]);
            let symbols = t.api.get(&format!("/symbols{q}")).await?;
            print_json(&symbols);
            output::emit(&output::Symbols { symbols });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_queries_from_set_parameters() {
        assert_eq!(query(&[("a", None)]), "");
        assert_eq!(
            query(&[
                ("query", Some("fn main".into())),
                ("at", Some("7".into())),
                ("p", None)
            ]),
            "?query=fn%20main&at=7"
        );
    }

    #[test]
    fn a_search_answer_becomes_its_groups() -> Result<()> {
        let answer = serde_json::json!({
            "query": "retry", "groups": ["code", "commits", "sessions", "changes"],
            "results": [{"path": "src/retry.rs", "lines": [{"line": 1, "text": "fn retry()"}]}],
            "memories": null,
            "commits": {"count": 2, "capped": false, "results": [{"commit": "a".repeat(40),
                "subject": "Retry fetches", "principal": "token:agent", "recorded_at": 5,
                "matched": ["subject"], "paths": ["src/fetch.rs"], "unknown": 1}]},
            "sessions": null,
            "changes": {"count": 0, "capped": false, "results": []},
        });
        let report = print_search(&answer)?;
        assert_eq!(report.code[0].path, "src/retry.rs");
        let commits = report
            .commits
            .as_ref()
            .map(|c| (c.count, c.results[0].subject.clone()));
        assert_eq!(commits, Some((2, "Retry fetches".to_owned())));
        assert!(report.memories.is_none() && report.sessions.is_none());
        assert_eq!(report.changes.map(|c| c.count), Some(0));
        let broken = serde_json::json!({"groups": [], "commits": {"count": "x"}});
        assert!(print_search(&broken).is_err());
        Ok(())
    }
}
