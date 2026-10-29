//! `yoneda memory`: the repository's memories. `add` leaves one for later coding sessions
//! (anchored to files, `path#symbol`s or `dir/`s; the platform resolves them at the commit,
//! default main's head) and, in a coding session, links it to the session and notes it so
//! the turn-end hook offers the session's summary as a draft memory; `list`, `show` and
//! `retire` read and retire them.
use crate::api::encode;
use crate::command::MemoryCommand;
use crate::error::Result;
use crate::session_files::{SessionFiles, current_session};
use crate::target::Resolved;
use serde_json::{Value, json};
use std::fmt::Write;

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

/// `path`, `path#symbol` or `dir/` as an anchor.
pub fn anchor(spec: &str) -> Value {
    match spec.split_once('#') {
        Some((path, symbol)) => json!({ "path": path, "symbol_path": symbol }),
        None => json!({ "path": spec }),
    }
}

/// Where a memory is anchored, as `src/net.rs#retry, docs/`.
pub fn anchors(memory: &Value) -> String {
    memory["anchors"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| match a["symbol_path"].as_str() {
            Some(symbol) => format!("{}#{symbol}", text(a, "path")),
            None => text(a, "path"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `#12 gotcha [stale] retry() must stay … (src/net.rs#retry) by token:agent`
fn line(memory: &Value) -> String {
    let mut out = format!("#{} {}", memory["id"], text(memory, "kind"));
    let status = text(memory, "status");
    if status != "active" {
        let _ = write!(out, " [{status}]");
    }
    if memory["stale"] == true {
        out.push_str(" [stale]");
    }
    let first = text(memory, "text");
    let _ = write!(out, " {}", first.lines().next().unwrap_or_default());
    let at = anchors(memory);
    if !at.is_empty() {
        let _ = write!(out, " ({at})");
    }
    let _ = write!(out, " by {}", text(memory, "author"));
    out
}

pub async fn run(t: &Resolved, command: MemoryCommand) -> Result<()> {
    match command {
        MemoryCommand::Add {
            kind,
            text,
            anchors,
            supersedes,
            commit,
        } => {
            let session = current_session();
            let body = json!({
                "kind": kind, "text": text, "commit": commit, "supersedes": supersedes,
                "session_id": session,
                "anchors": anchors.iter().map(|a| anchor(a)).collect::<Vec<_>>(),
            });
            let added = t.api.post("/memories", &body).await?;
            if let (Some(session), Some(clone)) = (&session, &t.clone) {
                SessionFiles::new(&clone.git_dir).note_memory_added(session)?;
            }
            let already = if added["already"] == true {
                " (already recorded)"
            } else {
                ""
            };
            println!(
                "Memory #{} at {}{already}",
                added["memory"],
                &self::text(&added, "commit")[..self::text(&added, "commit").len().min(7)]
            );
        }
        MemoryCommand::List {
            path,
            kind,
            status,
            json,
        } => {
            let mut query = String::from("/memories?limit=200");
            for (key, value) in [("path", path), ("kind", kind), ("status", status)] {
                if let Some(value) = value {
                    let _ = write!(query, "&{key}={}", encode(&value));
                }
            }
            let listed = t.api.get(&query).await?;
            if json {
                println!("{listed}");
                return Ok(());
            }
            let memories = listed["memories"].as_array().cloned().unwrap_or_default();
            if memories.is_empty() {
                println!("No memories.");
            }
            for memory in &memories {
                println!("{}", line(memory));
            }
        }
        MemoryCommand::Show { id, json } => {
            let shown = t.api.get(&format!("/memories/{id}")).await?;
            if json {
                println!("{shown}");
                return Ok(());
            }
            let memory = &shown["memory"];
            println!("{}", line(memory));
            println!("\n  {}\n", text(memory, "text").replace('\n', "\n  "));
            println!(
                "commit {} · session {}",
                text(memory, "commit"),
                memory["session_id"].as_str().unwrap_or("-")
            );
            for a in memory["anchors"].as_array().into_iter().flatten() {
                let state = match a["stale"].as_bool() {
                    Some(true) => "changed since",
                    Some(false) => "unchanged",
                    None => "unknown",
                };
                println!("  {} ({state})", anchors(&json!({ "anchors": [a] })));
            }
            if let Some(newer) = memory["superseded_by"].as_i64() {
                println!("superseded by #{newer}");
            }
        }
        MemoryCommand::Retire { id, reason } => {
            let retired = t
                .api
                .post(
                    &format!("/memories/{id}/retire"),
                    &json!({ "reason": reason }),
                )
                .await?;
            if retired["already"] == true {
                println!("Memory #{id} was retired already");
            } else {
                println!("Retired memory #{id}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_and_lines_read_like_the_command_line() {
        assert_eq!(
            anchor("src/net.rs#retry"),
            json!({"path":"src/net.rs","symbol_path":"retry"})
        );
        assert_eq!(anchor("docs/"), json!({"path":"docs/"}));
        let memory = json!({"id": 12, "kind": "gotcha", "status": "active", "stale": true,
            "text": "retry() must stay idempotent.\nThe queue replays it.", "author": "token:a",
            "anchors": [{"path":"src/net.rs","symbol_path":"retry"},{"path":"docs/","symbol_path":null}]});
        assert_eq!(
            line(&memory),
            "#12 gotcha [stale] retry() must stay idempotent. (src/net.rs#retry, docs/) by token:a"
        );
    }
}
