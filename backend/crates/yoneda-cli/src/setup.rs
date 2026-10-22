//! `yoneda setup claude|codex|gemini`: points a coding agent at the platform's account
//! MCP endpoint (`<origin>/api/v1/mcp`). The bearer is always read from `YONEDA_TOKEN`
//! when the agent runs; no token is ever written into a config file.
use crate::command::Agent;
use crate::error::{Context, Error, Result};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const TOKEN_ENV: &str = "YONEDA_TOKEN";

pub fn mcp_url(origin: &str) -> String {
    format!("{origin}/api/v1/mcp")
}

/// `config.toml` with the `[mcp_servers.yoneda]` table set to `url` (replacing an
/// earlier one; everything else kept as written).
pub fn codex_config(existing: &str, url: &str) -> String {
    let mut kept = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let header = line.trim_start().starts_with('[');
        if header {
            skipping = line.trim() == "[mcp_servers.yoneda]";
        }
        if !skipping {
            kept.push(line);
        }
    }
    let mut out = kept.join("\n").trim_end().to_owned();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!(
        "[mcp_servers.yoneda]\nurl = \"{url}\"\nbearer_token_env_var = \"{TOKEN_ENV}\"\n"
    ));
    out
}

/// The Claude Code server entry (`claude mcp add --transport http` shape); Claude Code
/// expands `${YONEDA_TOKEN}` when it connects.
pub fn claude_server(url: &str) -> Value {
    json!({
        "type": "http",
        "url": url,
        "headers": { "Authorization": format!("Bearer ${{{TOKEN_ENV}}}") }
    })
}

/// The Gemini CLI server entry (settings.json `mcpServers`).
pub fn gemini_server(url: &str) -> Value {
    json!({
        "httpUrl": url,
        "headers": { "Authorization": format!("Bearer ${{{TOKEN_ENV}}}") }
    })
}

/// `existing` JSON with `mcpServers.yoneda` set to `server`.
pub fn with_server(existing: &str, server: Value) -> Result<String> {
    let mut config: Value = if existing.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(existing).context("parsing the existing config")?
    };
    let root = config
        .as_object_mut()
        .ok_or_else(|| Error::new("the existing config is not a JSON object"))?;
    let servers = root.entry("mcpServers").or_insert_with(|| json!({}));
    servers
        .as_object_mut()
        .ok_or_else(|| Error::new("mcpServers is not a JSON object"))?
        .insert("yoneda".into(), server);
    serde_json::to_string_pretty(&config)
        .map(|s| s + "\n")
        .context("encoding the config")
}

fn home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| Error::new("HOME is not set"))
}

fn rewrite(path: &Path, change: impl FnOnce(&str) -> Result<String>) -> Result<()> {
    let existing = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(Error::new(format!("reading {}: {e}", path.display()))),
    };
    let updated = change(&existing)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context(format!("creating {}", dir.display()))?;
    }
    let staging = path.with_extension("yoneda-tmp");
    std::fs::write(&staging, updated).context(format!("writing {}", staging.display()))?;
    std::fs::rename(&staging, path).context(format!("replacing {}", path.display()))
}

/// Writes the agent's MCP configuration; returns the file written.
pub fn setup(agent: Agent, origin: &str, cwd: &Path) -> Result<PathBuf> {
    let url = mcp_url(origin);
    let path = match agent {
        Agent::Codex => {
            let base = std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .map_or_else(|| home().map(|h| h.join(".codex")), Ok)?;
            let path = base.join("config.toml");
            rewrite(&path, |text| Ok(codex_config(text, &url)))?;
            path
        }
        // Project scope: `.mcp.json` next to the code, the file Claude Code shares
        // with a team (`claude mcp add --scope user` is the per-person alternative).
        Agent::Claude => {
            let path = cwd.join(".mcp.json");
            rewrite(&path, |text| with_server(text, claude_server(&url)))?;
            path
        }
        Agent::Gemini => {
            let path = home()?.join(".gemini").join("settings.json");
            rewrite(&path, |text| with_server(text, gemini_server(&url)))?;
            path
        }
    };
    Ok(path)
}

pub fn run(agent: Agent, origin: &str) -> Result<()> {
    let cwd = std::env::current_dir().context("current directory")?;
    let path = setup(agent, origin, &cwd)?;
    println!(
        "Wrote the yoneda MCP server ({}) to {}",
        mcp_url(origin),
        path.display()
    );
    println!("The agent reads the token from ${TOKEN_ENV} (`yoneda login`, then export it).");
    if agent == Agent::Claude {
        println!(
            "Per-person instead: claude mcp add --transport http --scope user yoneda {} --header \"Authorization: Bearer ${{{TOKEN_ENV}}}\"",
            mcp_url(origin)
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://api.dev.yonedarepo.com/api/v1/mcp";

    #[test]
    fn replaces_only_the_yoneda_table_in_codex_config() {
        let existing = "model = \"x\"\n\n[mcp_servers.yoneda]\nurl = \"old\"\n\n[mcp_servers.other]\nurl = \"o\"\n";
        let out = codex_config(existing, URL);
        assert_eq!(out.matches("[mcp_servers.yoneda]").count(), 1);
        assert!(out.contains("model = \"x\"") && out.contains("[mcp_servers.other]\nurl = \"o\""));
        assert!(out.ends_with(&format!(
            "[mcp_servers.yoneda]\nurl = \"{URL}\"\nbearer_token_env_var = \"YONEDA_TOKEN\"\n"
        )));
        assert!(!out.contains("old"));
        assert_eq!(codex_config(&out, URL), out);
    }

    #[test]
    fn merges_json_servers_without_writing_a_token() -> Result<()> {
        let existing = r#"{"theme":"dark","mcpServers":{"other":{"url":"o"}}}"#;
        let out: Value =
            serde_json::from_str(&with_server(existing, gemini_server(URL))?).context("parse")?;
        assert_eq!(out["theme"], "dark");
        assert_eq!(out["mcpServers"]["other"]["url"], "o");
        assert_eq!(out["mcpServers"]["yoneda"]["httpUrl"], URL);
        let claude: Value =
            serde_json::from_str(&with_server("", claude_server(URL))?).context("parse")?;
        assert_eq!(
            claude["mcpServers"]["yoneda"]["headers"]["Authorization"],
            "Bearer ${YONEDA_TOKEN}"
        );
        assert!(with_server("[]", claude_server(URL)).is_err());
        Ok(())
    }

    #[test]
    fn writes_the_claude_project_file() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let path = setup(Agent::Claude, "https://api.dev.yonedarepo.com", dir.path())?;
        let text = std::fs::read_to_string(path).context("read")?;
        assert!(text.contains(URL) && !text.contains("ypat_"));
        Ok(())
    }
}
