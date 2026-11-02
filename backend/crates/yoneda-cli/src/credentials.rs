//! The platform token: `YONEDA_TOKEN`, else `~/.config/yoneda/credentials` written by
//! `yoneda login` with mode 0600. No OS keychain. A stored token is sent only to the
//! origin it was stored for; the value is never printed or passed on a command line.
//!
//! An agent has a slot of its own (`yoneda/agents/<name>/credentials`), so a person and their
//! agent stay signed in side by side. A run picks one with `YONEDA_AGENT`, which Git's helper
//! inherits too; an agent with no login there gets none, and never borrows the person's.
use crate::error::{Context, Error, Result};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize)]
struct Stored {
    origin: String,
    token: String,
}

/// A token and how the platform expects to receive it.
#[derive(Clone)]
pub struct Token(String);

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// The request header that carries a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Header {
    Authorization(String),
    Cookie(String),
    /// No credential (the device flow, before a token exists).
    None,
}

impl Token {
    pub fn new(value: &str) -> Result<Self> {
        let value = value.trim();
        if value.is_empty() || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(Error::new("The token is empty or contains whitespace"));
        }
        Ok(Self(value.to_owned()))
    }
    /// The token itself, for `yoneda auth token` alone; everything else sends it through
    /// `header`.
    pub fn secret(&self) -> &str {
        &self.0
    }
    /// Repository tokens (`yrp_`) and other bearers go in `Authorization`; a personal
    /// account session (`<account>.<64 hex>`, the only credential the platform lets
    /// `git clone`) goes in the account cookie.
    pub fn header(&self) -> Header {
        let session = self
            .0
            .strip_prefix("yoneda_account=")
            .unwrap_or(&self.0)
            .split_once('.')
            .filter(|(name, secret)| {
                !name.is_empty()
                    && !self.0.starts_with("yoneda.")
                    && !self.0.starts_with("yrp_")
                    && !self.0.starts_with("ypat_")
                    && secret.len() == 64
                    && secret.bytes().all(|b| b.is_ascii_hexdigit())
            });
        match session {
            Some((name, secret)) => Header::Cookie(format!("yoneda_account={name}.{secret}")),
            None => Header::Authorization(format!("Bearer {}", self.0)),
        }
    }
}

/// The home among `$HOME` and `%USERPROFILE%`. Windows' own OpenSSH reads the profile, and
/// Git Bash may set a `HOME` of its own, so there the profile wins.
fn pick_home(home: Option<OsString>, profile: Option<OsString>, windows: bool) -> Option<PathBuf> {
    let (first, second) = if windows {
        (profile, home)
    } else {
        (home, profile)
    };
    first
        .filter(|v| !v.is_empty())
        .or(second.filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

/// The person's home directory.
pub fn home_dir() -> Result<PathBuf> {
    pick_home(
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
        cfg!(windows),
    )
    .ok_or_else(|| Error::new("HOME is not set"))
}

/// `$XDG_CONFIG_HOME`, else `~/.config`.
fn config_home() -> Result<PathBuf> {
    match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(home_dir()?.join(".config")),
    }
}

/// The agent this run acts as, by name (`YONEDA_AGENT`; empty: none).
pub const AGENT_ENV: &str = "YONEDA_AGENT";

/// The agent `YONEDA_AGENT` names, if any.
pub fn env_agent() -> Option<String> {
    std::env::var(AGENT_ENV).ok().filter(|v| !v.is_empty())
}

/// This run's store: the agent's when `YONEDA_AGENT` names one, else the person's.
pub fn default_path() -> Result<PathBuf> {
    path_for(env_agent().as_deref())
}

/// `$XDG_CONFIG_HOME/yoneda/credentials` (else under `~/.config`), or `agent`'s slot there.
pub fn path_for(agent: Option<&str>) -> Result<PathBuf> {
    slot(&config_home()?, agent)
}

/// The platform's rule for an agent's name, which also keeps it one path component.
fn slot(config: &Path, agent: Option<&str>) -> Result<PathBuf> {
    let dir = config.join("yoneda");
    let Some(name) = agent else {
        return Ok(dir.join("credentials"));
    };
    let word = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let valid = name.len() <= 32
        && name.as_bytes().first().copied().is_some_and(word)
        && name.bytes().all(|b| word(b) || b == b'-' || b == b'_');
    if !valid {
        return Err(Error::usage(format!(
            "{name:?} is not an agent's name: 1-32 lowercase letters, digits, - and _"
        )));
    }
    Ok(dir.join("agents").join(name).join("credentials"))
}

/// Normalizes an origin to `scheme://host[:port]` without a trailing slash.
pub fn normalize_origin(origin: &str) -> Result<String> {
    let trimmed = origin.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or_else(|| Error::usage(format!("origin {origin:?} must start with https://")))?;
    if rest.is_empty() || rest.contains(['/', '?', '#', '@']) {
        return Err(Error::usage(format!(
            "origin {origin:?} must be scheme://host[:port] only"
        )));
    }
    Ok(trimmed.to_owned())
}

/// Stores `{origin, token}` with mode 0600 (created that way, never widened later).
pub fn store(path: &Path, origin: &str, token: &Token) -> Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| Error::new("Credentials path has no directory"))?;
    std::fs::create_dir_all(dir).context(format!("creating {}", dir.display()))?;
    let body = serde_json::to_vec(&Stored {
        origin: origin.to_owned(),
        token: token.0.clone(),
    })
    .context("encoding credentials")?;
    let staging = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        options.mode(0o600);
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .context(format!("restricting {}", dir.display()))?;
    }
    let mut file = options
        .open(&staging)
        .context(format!("writing {}", staging.display()))?;
    file.write_all(&body)
        .and_then(|()| file.sync_all())
        .context(format!("writing {}", staging.display()))?;
    std::fs::rename(&staging, path).context(format!("replacing {}", path.display()))
}

fn missing(origin: &str, agent: Option<&str>) -> String {
    match agent {
        Some(agent) => format!(
            "No token for agent {agent} on {origin}: run `yoneda login --agent {agent} --origin {origin}`"
        ),
        None => format!(
            "No token for {origin}: set YONEDA_TOKEN or run `yoneda login --origin {origin}`"
        ),
    }
}

/// The token for `origin`: `YONEDA_TOKEN` (`env`) wins; a stored token must belong to
/// the same origin.
pub fn load(path: &Path, origin: &str, env: Option<String>) -> Result<Token> {
    load_optional(path, origin, env)?
        .ok_or_else(|| Error::auth(missing(origin, env_agent().as_deref())))
}

/// The token for `origin` as `load` finds it, or `None` when there is none (a caller that
/// may go on without one: reading a public repository).
pub fn load_optional(path: &Path, origin: &str, env: Option<String>) -> Result<Option<Token>> {
    if let Some(value) = env.filter(|v| !v.trim().is_empty()) {
        return Token::new(&value).map(Some);
    }
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(Error::new(format!("reading {}: {e}", path.display()))),
    };
    let stored: Stored =
        serde_json::from_slice(&raw).context(format!("parsing {}", path.display()))?;
    if normalize_origin(&stored.origin)? != origin {
        return Ok(None);
    }
    Token::new(&stored.token).map(Some)
}

/// Deletes the stored token when it belongs to `origin` (any origin when `None`);
/// returns whether one was removed.
/// The stored login at `path`, on `origin` if one is named: its origin and token.
pub fn stored(path: &Path, origin: Option<&str>) -> Option<(String, Token)> {
    let raw = std::fs::read(path).ok()?;
    let stored: Stored = serde_json::from_slice(&raw).ok()?;
    let at = normalize_origin(&stored.origin).ok()?;
    if origin.is_some_and(|wanted| wanted != at) {
        return None;
    }
    Some((at, Token::new(&stored.token).ok()?))
}

pub fn remove(path: &Path, origin: Option<&str>) -> Result<bool> {
    let Some(stored) = stored_origin(path) else {
        return Ok(false);
    };
    if let Some(origin) = origin
        && normalize_origin(&stored)? != origin
    {
        return Ok(false);
    }
    std::fs::remove_file(path).context(format!("removing {}", path.display()))?;
    Ok(true)
}

/// The stored origin, for `clone` without `--origin`.
pub fn stored_origin(path: &Path) -> Option<String> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice::<Stored>(&raw)
        .ok()
        .map(|s| s.origin)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_home_is_the_profile_on_windows_and_home_elsewhere() {
        let os = |v: &str| Some(OsString::from(v));
        let path = |v: &str| Some(PathBuf::from(v));
        assert_eq!(pick_home(os("/h"), os(r"C:\p"), false), path("/h"));
        assert_eq!(pick_home(os("/h"), os(r"C:\p"), true), path(r"C:\p"));
        assert_eq!(pick_home(None, os(r"C:\p"), false), path(r"C:\p"));
        assert_eq!(pick_home(os("/h"), None, true), path("/h"));
        assert_eq!(pick_home(os(""), os(""), true), None);
        assert_eq!(pick_home(None, None, false), None);
    }

    #[test]
    fn stores_privately_and_loads_only_for_its_origin() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let path = dir.path().join("yoneda").join("credentials");
        store(&path, "https://a.example", &Token::new("yrp_secret\n")?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .context("stat")?
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let token = load(&path, "https://a.example", None)?;
        assert_eq!(
            token.header(),
            Header::Authorization("Bearer yrp_secret".into())
        );
        assert!(load(&path, "https://b.example", None).is_err());
        // Callers that may go on without a token (public reads) get none, not an error.
        assert!(load_optional(&path, "https://b.example", None)?.is_none());
        assert!(load_optional(&dir.path().join("missing"), "https://a.example", None)?.is_none());
        assert!(load_optional(&path, "https://a.example", None)?.is_some());
        let env = load(&path, "https://b.example", Some("yrp_env".into()))?;
        assert_eq!(env.header(), Header::Authorization("Bearer yrp_env".into()));
        assert!(!format!("{token:?}").contains("secret"));
        Ok(())
    }

    #[test]
    fn sends_an_account_session_as_its_cookie() -> Result<()> {
        let secret = "a".repeat(64);
        let token = Token::new(&format!("alice.{secret}"))?;
        assert_eq!(
            token.header(),
            Header::Cookie(format!("yoneda_account=alice.{secret}"))
        );
        // A personal access token is a bearer, whatever its shape.
        let pat = Token::new(&format!("ypat_alice.{secret}"))?;
        assert_eq!(
            pat.header(),
            Header::Authorization(format!("Bearer ypat_alice.{secret}"))
        );
        Ok(())
    }

    #[test]
    fn logout_removes_only_the_named_origins_token() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let path = dir.path().join("credentials");
        store(&path, "https://a.example", &Token::new("ypat_x")?)?;
        assert!(!remove(&path, Some("https://b.example"))?);
        assert!(path.exists());
        assert!(remove(&path, None)?);
        assert!(!path.exists() && !remove(&path, None)?);
        Ok(())
    }

    #[test]
    fn a_persons_login_stays_where_it_always_was() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let person = slot(dir.path(), None)?;
        assert_eq!(person, dir.path().join("yoneda").join("credentials"));
        // As an earlier CLI left it: a stored login reads as before.
        std::fs::create_dir_all(dir.path().join("yoneda")).context("mkdir")?;
        std::fs::write(
            &person,
            r#"{"origin":"https://a.example","token":"ypat_old"}"#,
        )
        .context("write")?;
        let read = load(&person, "https://a.example", None)?;
        assert_eq!(read.secret(), "ypat_old");
        Ok(())
    }

    #[test]
    fn an_agent_and_its_person_stay_signed_in_side_by_side() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        let origin = "https://a.example";
        let person = slot(dir.path(), None)?;
        let bot = slot(dir.path(), Some("bot"))?;
        let other = slot(dir.path(), Some("other"))?;
        assert_ne!(person, bot);
        assert_ne!(bot, other);
        store(&person, origin, &Token::new("ypat_person")?)?;
        store(&bot, origin, &Token::new("ypat_bot")?)?;
        assert_eq!(load(&person, origin, None)?.secret(), "ypat_person");
        assert_eq!(load(&bot, origin, None)?.secret(), "ypat_bot");
        // An agent with no login of its own never borrows the person's.
        assert!(load_optional(&other, origin, None)?.is_none());
        assert!(remove(&bot, None)?);
        assert_eq!(load(&person, origin, None)?.secret(), "ypat_person");
        store(&bot, origin, &Token::new("ypat_bot")?)?;
        assert!(remove(&person, None)?);
        assert_eq!(load(&bot, origin, None)?.secret(), "ypat_bot");
        Ok(())
    }

    #[test]
    fn an_agents_slot_is_private_and_its_name_stays_inside_it() -> Result<()> {
        let dir = tempfile::tempdir().context("tempdir")?;
        for bad in ["../x", "a/b", "Bot", ".", "..", "a b", &"x".repeat(33)] {
            assert!(slot(dir.path(), Some(bad)).is_err(), "{bad}");
        }
        let bot = slot(dir.path(), Some("review-bot_2"))?;
        assert!(bot.starts_with(dir.path().join("yoneda")));
        store(&bot, "https://a.example", &Token::new("ypat_bot")?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| -> Result<u32> {
                let meta = std::fs::metadata(p).context("stat")?;
                Ok(meta.permissions().mode() & 0o777)
            };
            assert_eq!(mode(&bot)?, 0o600);
            let parent = bot.parent().ok_or_else(|| Error::new("no parent"))?;
            assert_eq!(mode(parent)?, 0o700);
        }
        Ok(())
    }

    #[test]
    fn says_how_an_agent_signs_in_when_it_has_no_login() {
        assert!(missing("https://a.example", None).contains("yoneda login --origin"));
        let agent = missing("https://a.example", Some("bot"));
        assert!(
            agent.contains("yoneda login --agent bot --origin"),
            "{agent}"
        );
    }

    #[test]
    fn normalizes_origins() -> Result<()> {
        assert_eq!(normalize_origin("https://x.dev/")?, "https://x.dev");
        assert!(normalize_origin("x.dev").is_err());
        assert!(normalize_origin("https://x.dev/api").is_err());
        Ok(())
    }
}
