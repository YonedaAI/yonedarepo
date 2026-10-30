//! `yoneda setup claude|codex|gemini|opencode`: installs a coding agent's YonedaRepo files (the
//! skill or extension compiled in from `plugins/`) and points it at the platform's account
//! MCP endpoint (`<origin>/api/v1/mcp`). The bearer is always read from `YONEDA_TOKEN`
//! when the agent runs; no token is ever written into a file.
use crate::command::Agent;
use crate::error::{Context, Error, Result};
use crate::{human, output};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub const TOKEN_ENV: &str = "YONEDA_TOKEN";

/// The skill Codex reads from `~/.agents/skills/yoneda/`.
pub const CODEX_SKILL: &str = include_str!("../../../../plugins/codex/skills/yoneda/SKILL.md");
/// The Gemini CLI extension (`~/.gemini/extensions/yoneda/`): its manifest and context.
pub const GEMINI_MANIFEST: &str = include_str!("../../../../plugins/gemini/gemini-extension.json");
pub const GEMINI_CONTEXT: &str = include_str!("../../../../plugins/gemini/GEMINI.md");
/// The opencode 2 plugin (`<opencode config>/plugins/yoneda/index.ts`).
pub const OPENCODE_PLUGIN: &str = include_str!("../../../../plugins/opencode/yoneda/index.ts");
/// The plugin in the public marketplace the site serves (`plugins/public-marketplace.json`,
/// staged by `cargo xtask downloads`): a plain URL, so no Git host account is needed.
pub const CLAUDE_PLUGIN: &str = "yoneda@yonedarepo";

/// The public marketplace for the platform at `origin`: on the site beside it, whose host
/// is the API's without `api.` (`https://api.yonedarepo.com` → `https://yonedarepo.com`).
pub fn claude_marketplace(origin: &str) -> String {
    let site = match origin.split_once("://") {
        Some((scheme, host)) if host.starts_with("api.") => format!("{scheme}://{}", &host[4..]),
        _ => origin.to_owned(),
    };
    format!(
        "{}/downloads/claude/marketplace.json",
        site.trim_end_matches('/')
    )
}

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

/// `existing` opencode 2 config (JSON) with `mcp.servers.yoneda` set to the platform's
/// remote server; opencode substitutes `{env:YONEDA_TOKEN}` when it connects.
pub fn opencode_config(existing: &str, url: &str) -> Result<String> {
    let mut config: Value = if existing.trim().is_empty() {
        json!({ "$schema": "https://opencode.ai/config.json" })
    } else {
        serde_json::from_str(existing).map_err(|e| {
            Error::new(format!(
                "the existing opencode.json is not plain JSON ({e}); add plugins/opencode/opencode.jsonc's mcp entry by hand"
            ))
        })?
    };
    let server = json!({ "type": "remote", "url": url,
        "headers": { "Authorization": format!("Bearer {{env:{TOKEN_ENV}}}") } });
    let mcp = config
        .as_object_mut()
        .ok_or_else(|| Error::new("opencode.json is not a JSON object"))?
        .entry("mcp")
        .or_insert_with(|| json!({}));
    let servers = mcp
        .as_object_mut()
        .ok_or_else(|| Error::new("opencode.json's mcp is not a JSON object"))?
        .entry("servers")
        .or_insert_with(|| json!({}));
    servers
        .as_object_mut()
        .ok_or_else(|| Error::new("opencode.json's mcp.servers is not a JSON object"))?
        .insert("yoneda".into(), server);
    serde_json::to_string_pretty(&config)
        .map(|s| s + "\n")
        .context("encoding the config")
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

/// Writes `text` to `path` whatever was there (an installed copy of a plugin file).
fn install(path: &Path, text: &str) -> Result<()> {
    rewrite(path, |_| Ok(text.to_owned()))
}

/// Where `setup` writes: the person's home, Codex's home (`$CODEX_HOME`, default
/// `~/.codex`) and the directory a project-scoped file goes in.
pub struct Places {
    pub home: PathBuf,
    pub codex_home: Option<PathBuf>,
    /// `$XDG_CONFIG_HOME` (opencode's config is under it, default `~/.config`).
    pub xdg_config: Option<PathBuf>,
    pub cwd: PathBuf,
}

impl Places {
    fn from_env() -> Result<Self> {
        Ok(Self {
            home: std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or_else(|| Error::new("HOME is not set"))?,
            codex_home: std::env::var_os("CODEX_HOME").map(PathBuf::from),
            xdg_config: std::env::var_os("XDG_CONFIG_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            cwd: std::env::current_dir().context("current directory")?,
        })
    }
}

/// Installs the agent's files and MCP configuration; returns the files written.
pub fn setup(agent: Agent, origin: &str, at: &Places) -> Result<Vec<PathBuf>> {
    let url = mcp_url(origin);
    let mut written = Vec::new();
    match agent {
        Agent::Codex => {
            let base = at
                .codex_home
                .clone()
                .unwrap_or_else(|| at.home.join(".codex"));
            let config = base.join("config.toml");
            rewrite(&config, |text| Ok(codex_config(text, &url)))?;
            let skill = at.home.join(".agents/skills/yoneda/SKILL.md");
            install(&skill, CODEX_SKILL)?;
            written.extend([config, skill]);
        }
        // Project scope: `.mcp.json` next to the code, the file Claude Code shares with a
        // team. The skill and hook come with the plugin (installed inside Claude Code).
        Agent::Claude => {
            let path = at.cwd.join(".mcp.json");
            rewrite(&path, |text| with_server(text, claude_server(&url)))?;
            written.push(path);
        }
        Agent::Gemini => {
            let extension = at.home.join(".gemini/extensions/yoneda");
            let manifest = extension.join("gemini-extension.json");
            rewrite(&manifest, |_| {
                with_server(GEMINI_MANIFEST, gemini_server(&url))
            })?;
            let context = extension.join("GEMINI.md");
            install(&context, GEMINI_CONTEXT)?;
            let settings = at.home.join(".gemini/settings.json");
            rewrite(&settings, |text| with_server(text, gemini_server(&url)))?;
            written.extend([manifest, context, settings]);
        }
        Agent::Opencode => {
            let base = at
                .xdg_config
                .clone()
                .unwrap_or_else(|| at.home.join(".config"))
                .join("opencode");
            let plugin = base.join("plugins/yoneda/index.ts");
            install(&plugin, OPENCODE_PLUGIN)?;
            let config = base.join("opencode.json");
            rewrite(&config, |text| opencode_config(text, &url))?;
            written.extend([plugin, config]);
        }
    }
    Ok(written)
}

pub fn run(agent: Agent, origin: &str) -> Result<()> {
    let written = setup(agent, origin, &Places::from_env()?)?;
    for path in &written {
        human!("Wrote {}", path.display());
    }
    human!("MCP server: {}", mcp_url(origin));
    human!("The agent reads the token from ${TOKEN_ENV} (`yoneda login`, then export it).");
    if agent == Agent::Claude {
        human!("Install the skill and session hook inside Claude Code:");
        human!("  /plugin marketplace add {}", claude_marketplace(origin));
        human!("  /plugin install {CLAUDE_PLUGIN}");
        human!(
            "Per-person MCP instead of .mcp.json: claude mcp add --transport http --scope user yoneda {} --header \"Authorization: Bearer ${{{TOKEN_ENV}}}\"",
            mcp_url(origin)
        );
    }
    output::emit(&output::Setup {
        agent: format!("{agent:?}").to_lowercase(),
        written: written.iter().map(|p| p.display().to_string()).collect(),
        mcp_url: mcp_url(origin),
        token_env: TOKEN_ENV.to_owned(),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "https://api.example.test";
    const URL: &str = "https://api.dev.yonedarepo.com/api/v1/mcp";

    fn places(dir: &Path) -> Places {
        Places {
            home: dir.join("home"),
            codex_home: None,
            xdg_config: None,
            cwd: dir.join("project"),
        }
    }

    fn read(path: &Path) -> Result<String> {
        std::fs::read_to_string(path).context(format!("reading {}", path.display()))
    }

    #[test]
    fn finds_the_public_marketplace_on_the_site_beside_the_api() {
        assert_eq!(
            claude_marketplace("https://api.yonedarepo.com"),
            "https://yonedarepo.com/downloads/claude/marketplace.json"
        );
        assert_eq!(
            claude_marketplace("https://api.dev.yonedarepo.com"),
            "https://dev.yonedarepo.com/downloads/claude/marketplace.json"
        );
        assert_eq!(
            claude_marketplace("http://127.0.0.1:8787"),
            "http://127.0.0.1:8787/downloads/claude/marketplace.json"
        );
    }

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
    fn codex_gets_its_skill_and_config() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let at = places(dir.path());
        let written = setup(Agent::Codex, ORIGIN, &at)?;
        let skill = at.home.join(".agents/skills/yoneda/SKILL.md");
        assert_eq!(read(&skill)?, CODEX_SKILL);
        let config = read(&at.home.join(".codex/config.toml"))?;
        assert!(config.contains(&format!("url = \"{ORIGIN}/api/v1/mcp\"")));
        assert_eq!(written.len(), 2);
        // `$CODEX_HOME` moves the config, not the skill.
        let moved = Places {
            codex_home: Some(dir.path().join("codex")),
            ..places(dir.path())
        };
        setup(Agent::Codex, ORIGIN, &moved)?;
        assert!(dir.path().join("codex/config.toml").exists());
        Ok(())
    }

    #[test]
    fn gemini_gets_the_extension_pointed_at_the_origin() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let at = places(dir.path());
        setup(Agent::Gemini, ORIGIN, &at)?;
        let extension = at.home.join(".gemini/extensions/yoneda");
        assert_eq!(read(&extension.join("GEMINI.md"))?, GEMINI_CONTEXT);
        let manifest: Value =
            serde_json::from_str(&read(&extension.join("gemini-extension.json"))?)
                .context("manifest")?;
        assert_eq!(manifest["name"], "yoneda");
        assert_eq!(manifest["contextFileName"], "GEMINI.md");
        assert_eq!(
            manifest["mcpServers"]["yoneda"]["httpUrl"],
            format!("{ORIGIN}/api/v1/mcp")
        );
        let settings = read(&at.home.join(".gemini/settings.json"))?;
        assert!(settings.contains(&format!("{ORIGIN}/api/v1/mcp")));
        Ok(())
    }

    #[test]
    fn opencode_gets_the_plugin_and_its_mcp_server() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let at = places(dir.path());
        let base = at.home.join(".config/opencode");
        std::fs::create_dir_all(&base).context("mkdir")?;
        std::fs::write(
            base.join("opencode.json"),
            r#"{"model":"zai-coding-plan/glm-5.3","mcp":{"servers":{"other":{"type":"local","command":["x"]}}}}"#,
        )
        .context("write")?;
        let written = setup(Agent::Opencode, ORIGIN, &at)?;
        assert_eq!(written.len(), 2);
        assert_eq!(
            read(&base.join("plugins/yoneda/index.ts"))?,
            OPENCODE_PLUGIN
        );
        let config: Value =
            serde_json::from_str(&read(&base.join("opencode.json"))?).context("config")?;
        assert_eq!(config["model"], "zai-coding-plan/glm-5.3");
        assert_eq!(config["mcp"]["servers"]["other"]["type"], "local");
        let yoneda = &config["mcp"]["servers"]["yoneda"];
        assert_eq!(yoneda["url"], format!("{ORIGIN}/api/v1/mcp"));
        assert_eq!(
            yoneda["headers"]["Authorization"],
            "Bearer {env:YONEDA_TOKEN}"
        );
        assert!(opencode_config("// jsonc\n{}", URL).is_err());
        Ok(())
    }

    #[test]
    fn claude_gets_the_project_file() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let at = places(dir.path());
        let written = setup(Agent::Claude, ORIGIN, &at)?;
        assert_eq!(written, [at.cwd.join(".mcp.json")]);
        assert!(read(&written[0])?.contains(&format!("{ORIGIN}/api/v1/mcp")));
        Ok(())
    }

    /// Whether `text` holds something shaped like a token (a prefix and its secret; the
    /// bare prefix may appear in prose).
    fn holds_token(text: &str) -> bool {
        ["ypat_", "yrp_"].iter().any(|prefix| {
            text.match_indices(prefix).any(|(i, _)| {
                text[i + prefix.len()..]
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
            })
        })
    }

    #[test]
    fn no_installed_file_holds_a_token() -> Result<()> {
        assert!(holds_token("Bearer ypat_abc") && !holds_token("A ypat_ token"));
        let dir = tempfile::tempdir().context("tempdir")?;
        let at = places(dir.path());
        for agent in [Agent::Codex, Agent::Gemini, Agent::Claude] {
            for path in setup(agent, ORIGIN, &at)? {
                let text = read(&path)?;
                assert!(!holds_token(&text), "{}", path.display());
                assert!(!text.contains("Bearer ") || text.contains("Bearer ${YONEDA_TOKEN}"));
            }
        }
        Ok(())
    }
}
