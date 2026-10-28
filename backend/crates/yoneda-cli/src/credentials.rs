//! The platform token: `YONEDA_TOKEN`, else `~/.config/yoneda/credentials` written by
//! `yoneda login` with mode 0600. No OS keychain. A stored token is sent only to the
//! origin it was stored for; the value is never printed or passed on a command line.
use crate::error::{Context, Error, Result};
use serde::{Deserialize, Serialize};
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

/// `$XDG_CONFIG_HOME/yoneda/credentials`, else `~/.config/yoneda/credentials`.
pub fn default_path() -> Result<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => {
            PathBuf::from(std::env::var_os("HOME").ok_or_else(|| Error::new("HOME is not set"))?)
                .join(".config")
        }
    };
    Ok(base.join("yoneda").join("credentials"))
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

/// The token for `origin`: `YONEDA_TOKEN` (`env`) wins; a stored token must belong to
/// the same origin.
pub fn load(path: &Path, origin: &str, env: Option<String>) -> Result<Token> {
    if let Some(value) = env.filter(|v| !v.trim().is_empty()) {
        return Token::new(&value);
    }
    let missing = || {
        Error::new(format!(
            "No token for {origin}: set YONEDA_TOKEN or run `yoneda login --origin {origin}`"
        ))
    };
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(missing()),
        Err(e) => return Err(Error::new(format!("reading {}: {e}", path.display()))),
    };
    let stored: Stored =
        serde_json::from_slice(&raw).context(format!("parsing {}", path.display()))?;
    if normalize_origin(&stored.origin)? != origin {
        return Err(missing());
    }
    Token::new(&stored.token)
}

/// Deletes the stored token when it belongs to `origin` (any origin when `None`);
/// returns whether one was removed.
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
    fn normalizes_origins() -> Result<()> {
        assert_eq!(normalize_origin("https://x.dev/")?, "https://x.dev");
        assert!(normalize_origin("x.dev").is_err());
        assert!(normalize_origin("https://x.dev/api").is_err());
        Ok(())
    }
}
