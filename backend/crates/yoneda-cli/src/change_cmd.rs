//! `yoneda change`: change requests. A change proposes a pushed branch for landing on its
//! base (main unless `--base` names another branch); its head is the branch's current
//! commit, approved with `yoneda review approve <head>` and landed on the base with
//! `yoneda change land <n>`.
use crate::command::ChangeCommand;
use crate::error::{Error, Result};
use crate::repo_ops::{current_branch, land_head};
use crate::target::Resolved;
use serde_json::{Value, json};

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

/// `#3 [open] Retry twice (fix -> main) by token:agent`
fn summary(change: &Value) -> String {
    format!(
        "#{} [{}] {} ({} -> {}) by {}",
        change["number"],
        text(change, "status"),
        text(change, "title"),
        text(change, "branch"),
        text(change, "base"),
        text(change, "author"),
    )
}

fn names(list: &Value) -> String {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

/// One line on whether the head can land, and why not.
fn gates(gates: &Value) -> String {
    if gates["ready"] == true {
        return "ready to land".into();
    }
    let mut why = vec![format!(
        "approvals {}/{}",
        gates["approvals"], gates["approvals_required"]
    )];
    if gates["rejected"] == true {
        why.push("rejected".into());
    }
    for (key, label) in [
        ("missing_checks", "waiting for"),
        ("failing_checks", "failing"),
    ] {
        let listed = names(&gates[key]);
        if !listed.is_empty() {
            why.push(format!("{label} {listed}"));
        }
    }
    format!("not ready: {}", why.join("; "))
}

fn show(change: &Value) {
    println!("{}", summary(change));
    if let Some(fork) = change["source_repo"].as_str() {
        println!("from fork {fork} branch {}", text(change, "source_branch"));
    }
    if !text(change, "body").is_empty() {
        println!("\n  {}\n", text(change, "body").replace('\n', "\n  "));
    }
    match change["head"].as_str() {
        Some(head) => println!("head {head}"),
        None => println!("head: none (the branch is gone)"),
    }
    if change["status"] == "landed" {
        println!("landed at version {}", change["landed_version"]);
    } else if let Some(record) = change["head_commit"].as_object() {
        println!("{}", gates(&record["gates"]));
        for review in record["reviews"].as_array().into_iter().flatten() {
            println!(
                "  {} by {}{}",
                text(review, "decision"),
                text(review, "principal"),
                review["reason"]
                    .as_str()
                    .map(|r| format!(": {r}"))
                    .unwrap_or_default()
            );
        }
    }
    let files = change["diff"]["changes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    println!("{} file(s) changed", files.len());
    for file in &files {
        println!("  {} {}", text(file, "op"), text(file, "path"));
    }
    for comment in change["comments"].as_array().into_iter().flatten() {
        let at = match comment["path"].as_str() {
            Some(path) => format!(" on {path}:{} ({})", comment["line"], text(comment, "side")),
            None => String::new(),
        };
        let resolved = if comment["resolved_at"].is_null() {
            ""
        } else {
            " [resolved]"
        };
        println!("- {}{at}{resolved}", text(comment, "principal"));
        println!("  {}", text(comment, "body").replace('\n', "\n  "));
    }
}

pub async fn run(t: &Resolved, command: ChangeCommand) -> Result<()> {
    match command {
        ChangeCommand::Create {
            branch,
            title,
            body,
            base,
            to_parent,
        } => {
            let branch = branch
                .or_else(|| current_branch(t))
                .ok_or_else(|| Error::usage("change create needs a branch outside a clone"))?;
            // Default title: the branch's last commit subject in this clone, else its name.
            let title = title
                .or_else(|| {
                    let clone = t.clone.as_ref()?;
                    clone.git.run(&["log", "-1", "--format=%s", &branch]).ok()
                })
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| branch.clone());
            let mut body = json!({ "branch": branch, "title": title, "body": body });
            if let Some(base) = base {
                body["base"] = json!(base);
            }
            // From a fork: the parent opens it, carrying this fork's branch across.
            if to_parent {
                let status = t.api.status().await?;
                let parent = status["parent"]["repo"]
                    .as_str()
                    .ok_or_else(|| Error::usage(format!("{} is not a fork", t.repo)))?;
                body["fork"] = json!(t.repo);
                let change = t.api.sibling(parent)?.post("/changes", &body).await?;
                println!("Opened on {parent}: {}", summary(&change));
                println!(
                    "next: a reviewer of {parent} approves {}, then yoneda change land {} --repo {parent}",
                    text(&change, "head"),
                    change["number"]
                );
                return Ok(());
            }
            let change = t.api.post("/changes", &body).await?;
            println!("Opened {}", summary(&change));
            println!(
                "next: yoneda review approve {} (a reviewer), then yoneda change land {}",
                text(&change, "head"),
                change["number"]
            );
        }
        ChangeCommand::List { status } => {
            let status = status.unwrap_or_else(|| "open".into());
            let listed = t
                .api
                .get(&format!("/changes?status={}", crate::api::encode(&status)))
                .await?;
            let changes = listed["changes"].as_array().cloned().unwrap_or_default();
            if changes.is_empty() {
                println!("No {status} changes");
            }
            for change in &changes {
                println!("{}", summary(change));
            }
        }
        ChangeCommand::Show { number } => show(&t.api.get(&format!("/changes/{number}")).await?),
        ChangeCommand::Comment {
            number,
            body,
            anchor,
            resolve,
        } => {
            let mut request = json!({ "body": body, "resolve": resolve });
            if let Some(anchor) = anchor {
                request["path"] = json!(anchor.path);
                request["line"] = json!(anchor.line);
                request["side"] = json!(anchor.side);
            }
            let posted = t
                .api
                .post(&format!("/changes/{number}/comments"), &request)
                .await?;
            if !posted["comment"].is_null() {
                println!("Commented on change #{number}");
            }
            if resolve {
                println!("Resolved {} comment(s)", posted["resolved"]);
            }
        }
        ChangeCommand::Land { number } => {
            let change = t.api.get(&format!("/changes/{number}")).await?;
            if change["status"] != "open" {
                return Err(Error::new(format!(
                    "change #{number} is {}, not open",
                    text(&change, "status")
                )));
            }
            let head = change["head"]
                .as_str()
                .ok_or_else(|| Error::new(format!("change #{number} has no head commit")))?;
            let base = change["base"].as_str().unwrap_or("main");
            land_head(t, &format!("change #{number}"), head, base).await?;
        }
        ChangeCommand::Close { number } => {
            let change = t
                .api
                .post(&format!("/changes/{number}/close"), &json!({}))
                .await?;
            println!("Closed {}", summary(&change));
            println!("next: yoneda change reopen {number}, or yoneda change delete {number}");
        }
        ChangeCommand::Reopen { number } => {
            let change = t
                .api
                .post(&format!("/changes/{number}/reopen"), &json!({}))
                .await?;
            println!("Reopened {}", summary(&change));
        }
        ChangeCommand::Delete { number } => {
            t.api.delete(&format!("/changes/{number}")).await?;
            println!("Deleted change #{number}");
        }
    }
    Ok(())
}
