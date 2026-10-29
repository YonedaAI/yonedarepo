//! Server-side reads with no checkout: log, grep, blame, diff and symbols, optionally at
//! an earlier log version (`--at`, time travel on the transaction log).
use crate::api::encode;
use crate::command::ReadCommand;
use crate::error::Result;
use crate::human;
use crate::output::{self, DiffEntry, GrepFile, GrepLine, LogEntry};
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
}
