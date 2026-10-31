//! `yoneda context`: what a coding session starting in this clone should know, as compact
//! text for the agent (the session-start hooks inject it). One platform read
//! (`GET /context`) gives main's and the branch's heads, the landing rules, the
//! repository's memories ranked for the paths this clone is changing, the newest session
//! records, open changes and the contracts on those paths; the local status line says what
//! is not pushed yet. Open findings on this branch's change (`go_around`) come first: they
//! are what this session is back for. The text is capped (6 KiB by default): sections fill in order and
//! whatever does not fit is counted, not cut mid-line (`context_render`). The hooks record
//! which items the packet carried (`Rendered::items`), so later injections do not repeat them.
use crate::command::Target;
pub use crate::context_render::{Rendered, render, render_items};
use crate::error::{Error, Result};
use crate::target::{self, Clone};
use serde_json::Value;
use std::fmt::Write;
use std::time::Duration;

pub const DEFAULT_BYTES: usize = 6 * 1024;
const SESSIONS: u64 = 8;
const CHANGES: u64 = 10;
const CONTRACTS: u64 = 5;
const MEMORIES: u64 = 8;
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
    let mut q = format!(
        "/context?sessions={SESSIONS}&changes={CHANGES}&contracts={CONTRACTS}&memories={MEMORIES}"
    );
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
pub async fn run(max_bytes: usize) -> Result<()> {
    let (local, read) = gather().await?;
    crate::human!("{}", render(&read, &local, max_bytes, now_ms()));
    crate::output::emit(&crate::output::Context {
        brief: local.brief,
        branch: local.branch,
        context: read,
    });
    Ok(())
}

/// The context for a session-start hook; a failure becomes one line saying so (and no
/// items).
pub async fn for_hook(max_bytes: usize) -> Rendered {
    match gather().await {
        Ok((local, read)) => render_items(&read, &local, max_bytes, now_ms()),
        Err(e) => Rendered {
            text: format!(
                "YonedaRepo: this clone's repository context is unavailable ({e}); `yoneda context` retries."
            ),
            items: Vec::new(),
        },
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_for_the_branch_and_the_changed_paths() {
        let local = Local {
            brief: None,
            branch: Some("feat/x y".into()),
        };
        assert_eq!(
            query(&local, &["src/a.rs".into(), "b c.rs".into()]),
            "/context?sessions=8&changes=10&contracts=5&memories=8&branch=feat/x%20y&paths=src/a.rs,b%20c.rs"
        );
        assert_eq!(
            query(&Local::default(), &[]),
            "/context?sessions=8&changes=10&contracts=5&memories=8"
        );
    }
}
