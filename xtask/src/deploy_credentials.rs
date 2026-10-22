//! The Cloudflare API token for a workstation deploy. CI sets `CLOUDFLARE_API_TOKEN`; on the
//! owner's Mac it lives in `~/.config/yonedarepo/deploy-<env>.env` (mode 0600, `KEY=VALUE`
//! lines). A set variable wins and the file is then not read. The token only ever reaches
//! child process environments (wrangler): it is never printed, logged or put in arguments.
use crate::process::Result;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

pub(crate) const TOKEN_VAR: &str = "CLOUDFLARE_API_TOKEN";
const ACCOUNT_VAR: &str = "CLOUDFLARE_ACCOUNT_ID";

/// The token read from the file, handed to every wrangler child process.
static FILE_TOKEN: OnceLock<Token> = OnceLock::new();

/// A credential whose `Debug` output never shows the value.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Token(String);

impl std::fmt::Debug for Token {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

/// Where the token came from (the only thing about it that is ever printed).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Origin {
    /// `CLOUDFLARE_API_TOKEN` was already set; children inherit it.
    Environment,
    /// Read from this file; children get it through [`apply`].
    File(PathBuf),
}

/// `~/.config/yonedarepo/deploy-<env>.env`.
pub(crate) fn path(env_name: &str) -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set; cannot find the deploy token")?;
    Ok(PathBuf::from(home).join(format!(".config/yonedarepo/deploy-{env_name}.env")))
}

/// Decides where the token comes from. `from_env` is the current `CLOUDFLARE_API_TOKEN`;
/// when it is set (non-empty) the file is not touched at all. Errors name files and keys,
/// never values.
pub(crate) fn resolve(
    from_env: Option<String>,
    file: &Path,
    account_id: &str,
) -> Result<(Option<Token>, Origin)> {
    if from_env.is_some_and(|value| !value.trim().is_empty()) {
        return Ok((None, Origin::Environment));
    }
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!(
                "No Cloudflare API token: {TOKEN_VAR} is not set and {} does not exist. Create it with mode 0600 holding {TOKEN_VAR}=<token> and {ACCOUNT_VAR}={account_id}.",
                file.display()
            )
            .into());
        }
        Err(error) => {
            return Err(format!("Cannot read {}: {}", file.display(), error.kind()).into());
        }
    };
    private_file(file)?;
    let values = crate::infra::secrets::parse(&text);
    if let Some(account) = values.get(ACCOUNT_VAR)
        && account != account_id
    {
        return Err(format!(
            "Refusing: {} names account {account}, but this environment deploys to {account_id}.",
            file.display()
        )
        .into());
    }
    match values.get(TOKEN_VAR).filter(|v| !v.trim().is_empty()) {
        Some(token) => Ok((
            Some(Token(token.trim().to_owned())),
            Origin::File(file.into()),
        )),
        None => Err(format!("{} has no {TOKEN_VAR} line.", file.display()).into()),
    }
}

/// A token file others can read is refused, so a leaked copy is noticed, not used.
#[cfg(unix)]
fn private_file(file: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(file)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(format!(
            "Refusing: {} is readable by other users (mode {mode:o}); run chmod 600 on it.",
            file.display()
        )
        .into());
    }
    Ok(())
}

#[cfg(not(unix))]
fn private_file(_file: &Path) -> Result<()> {
    Ok(())
}

/// Resolves the token for `env_name` and makes later wrangler calls use it. Prints only the
/// origin.
pub(crate) fn load(env_name: &str, account_id: &str) -> Result<Origin> {
    let (token, origin) = resolve(std::env::var(TOKEN_VAR).ok(), &path(env_name)?, account_id)?;
    if let Some(token) = token {
        // A second load in one process keeps the first token (same file, same value).
        let _ = FILE_TOKEN.set(token);
    }
    match &origin {
        Origin::Environment => println!("Cloudflare token: {TOKEN_VAR} from the environment"),
        Origin::File(file) => println!("Cloudflare token: {}", file.display()),
    }
    Ok(origin)
}

/// Gives a child process the file token, when one was loaded.
pub(crate) fn apply(command: &mut Command) {
    if let Some(Token(token)) = FILE_TOKEN.get() {
        command.env(TOKEN_VAR, token);
    }
}

#[cfg(test)]
#[path = "deploy_credentials/tests.rs"]
mod tests;
