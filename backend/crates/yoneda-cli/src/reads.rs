//! Server-side reads with no checkout: log, grep, blame, diff and symbols, optionally at
//! an earlier log version (`--at`, time travel on the transaction log).
use crate::api::encode;
use crate::command::ReadCommand;
use crate::error::Result;
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
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
    );
}

/// One line per search hit: `path:line: text` where the platform names them.
fn print_hits(found: &Value) {
    for result in found["results"].as_array().into_iter().flatten() {
        let path = result["path"].as_str().unwrap_or("?");
        let lines = result["lines"].as_array().cloned().unwrap_or_default();
        if lines.is_empty() {
            println!("{path}");
        }
        for line in lines {
            let number = line["line"].as_u64().or_else(|| line["number"].as_u64());
            let text = line["text"].as_str().or_else(|| line.as_str());
            match (number, text) {
                (Some(n), Some(t)) => println!("{path}:{n}: {t}"),
                _ => println!("{path}: {line}"),
            }
        }
    }
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
            for commit in log["commits"].as_array().into_iter().flatten() {
                let landed = commit["landed"]["version"]
                    .as_u64()
                    .map(|v| format!("v{v} "))
                    .unwrap_or_default();
                println!(
                    "{} {landed}{}",
                    commit["commit"].as_str().unwrap_or("?"),
                    first_line(commit["message"].as_str().unwrap_or_default())
                );
            }
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
            print_hits(&t.api.get(&format!("/search{q}")).await?);
        }
        ReadCommand::Blame { path, branch } => {
            let q = query(&[("path", Some(path)), ("ref", branch)]);
            print_json(&t.api.get(&format!("/blame{q}")).await?);
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
            for change in diff["changes"].as_array().into_iter().flatten() {
                match change["patch"].as_str() {
                    Some(patch) => print!("{patch}"),
                    None => println!(
                        "{} {}",
                        change["status"].as_str().unwrap_or("M"),
                        change["path"].as_str().unwrap_or("?")
                    ),
                }
            }
        }
        ReadCommand::Symbols { path, at: version } => {
            let q = query(&[("path", Some(path)), ("at", at(version))]);
            print_json(&t.api.get(&format!("/symbols{q}")).await?);
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
