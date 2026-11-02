//! `admin imports --env <env>`: every repository and what it needs now Artifacts has gone, through
//! the deployed platform's `GET /api/v1/admin/imports` as the owner, a page at a time.
//! `admin reimport --env <env> --repo <id> [--url <url>] [--branch <branch>] [--confirm]`: clones
//! one again under the same id and name (`POST /api/v1/admin/repos/<id>/reimport`). Without
//! `--confirm` it says what it would do. Audited. It empties the repository's history first, so
//! run it only on a confirmed list (docs/runbook.md).
use crate::infra::spec::Env;
use crate::process::Result;
use serde_json::{Map, Value, json};
use std::time::Duration;

/// The value after `flag`.
fn option<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let at = args.iter().position(|a| a == flag)?;
    args.get(at + 1).map(String::as_str)
}

fn text(row: &Value, key: &str) -> String {
    match &row[key] {
        Value::Null => "-".into(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// One repository as a line of the table.
fn line(row: &Value) -> String {
    format!(
        "{:<9} {:<22} {:<28} {:>8} {:>8} {:>6} {:<5} {}",
        text(row, "needs"),
        text(row, "id"),
        text(row, "name"),
        text(row, "commits"),
        text(row, "imported_commits"),
        text(row, "store_commits"),
        text(row, "head_readable"),
        text(row, "url"),
    )
}

/// How many repositories need `what`.
fn count(rows: &[Value], what: &str) -> usize {
    rows.iter().filter(|r| r["needs"] == what).count()
}

/// The request's body: only what was given.
fn body(args: &[String]) -> Value {
    let mut asked = Map::new();
    for key in ["url", "branch"] {
        if let Some(value) = option(args, &format!("--{key}")) {
            asked.insert(key.into(), json!(value));
        }
    }
    if args.iter().any(|a| a == "--confirm") {
        asked.insert("confirm".into(), json!(true));
    }
    Value::Object(asked)
}

pub(crate) async fn list(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let (_, _, origin, owner) = crate::admin::platform(&env)?;
    let client = crate::admin::platform_client(Duration::from_secs(120))?;
    println!(
        "{:<9} {:<22} {:<28} {:>8} {:>8} {:>6} {:<5} url",
        "needs", "id", "name", "commits", "imported", "whole", "head"
    );
    let mut rows = Vec::new();
    let mut after = String::new();
    loop {
        let response = client
            .get(format!("{origin}/api/v1/admin/imports?after={after}"))
            .bearer_auth(&owner)
            .send()
            .await?;
        let status = response.status();
        let page: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(format!("HTTP {status}: {page}").into());
        }
        for row in page["repositories"].as_array().into_iter().flatten() {
            println!("{}", line(row));
            rows.push(row.clone());
        }
        match page["next"].as_str() {
            Some(next) => after = next.to_string(),
            None => break,
        }
    }
    println!(
        "{} repositories: {} to re-import, {} to check, {} fine",
        rows.len(),
        count(&rows, "reimport"),
        count(&rows, "check"),
        count(&rows, "nothing"),
    );
    Ok(())
}

pub(crate) async fn execute(args: &[String]) -> Result<()> {
    let env = Env::from_args(args)?;
    let Some(repo) = option(args, "--repo") else {
        return Err(
            "cargo xtask admin reimport --env dev|prod --repo <id> [--url <url>] [--branch <branch>] [--confirm]"
                .into(),
        );
    };
    let (_, _, origin, owner) = crate::admin::platform(&env)?;
    let client = crate::admin::platform_client(Duration::from_secs(120))?;
    let response = client
        .post(format!("{origin}/api/v1/admin/repos/{repo}/reimport"))
        .bearer_auth(&owner)
        .json(&body(args))
        .send()
        .await?;
    let status = response.status();
    let answer: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("{repo}: HTTP {status}: {answer}").into());
    }
    println!("{answer}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{body, count, line};
    use serde_json::json;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn sends_only_what_was_given_and_confirms_only_when_told() {
        let dry = body(&args(&["admin", "reimport", "--repo", "r1"]));
        assert_eq!(dry, json!({}));
        let done = body(&args(&[
            "admin",
            "reimport",
            "--repo",
            "r1",
            "--url",
            "https://github.com/a/b",
            "--branch",
            "dev",
            "--confirm",
        ]));
        assert_eq!(
            done,
            json!({"url":"https://github.com/a/b","branch":"dev","confirm":true})
        );
    }

    #[test]
    fn a_line_shows_what_is_missing_as_a_dash() {
        let row = json!({"needs":"check","id":"r1","name":"x","url":null,"error":"GONE"});
        let shown = line(&row);
        assert!(shown.starts_with("check"));
        assert!(shown.ends_with(" -"));
    }

    #[test]
    fn counts_by_need() {
        let rows = [json!({"needs":"reimport"}), json!({"needs":"nothing"})];
        assert_eq!(count(&rows, "reimport"), 1);
        assert_eq!(count(&rows, "check"), 0);
    }
}
