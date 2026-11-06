//! The paired cloud repository, as Git and the platform API see it: its origin and id, the
//! caller's cloud credential (the same lookup as the `yoneda` CLI: `YONEDA_TOKEN`, an
//! agent's slot under `YONEDA_AGENT`, else the stored login for that origin), and Git runs
//! against `<origin>/git/<id>.git` whose credential comes from this binary's helper, so
//! the token is never in an argument, a URL, a log or Git's config.
use crate::layout::local_error;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use yoneda_core::Result;

/// Environment naming the one origin the cloud credential helper answers for.
pub const CLOUD_ENV: &str = "YONEDA_LOCAL_CLOUD";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cloud {
    /// `scheme://host[:port]`, no trailing slash.
    pub origin: String,
    pub repo: String,
}

impl Cloud {
    pub fn git_url(&self) -> String {
        format!("{}/git/{}.git", self.origin, self.repo)
    }
}

/// `scheme://host[:port]` of `url` (a `yoneda::` prefix is ignored).
pub fn origin_of(url: &str) -> Option<String> {
    let url = url.trim().trim_start_matches("yoneda::");
    let (scheme, rest) = url.split_once("://")?;
    if !matches!(scheme, "http" | "https") {
        return None;
    }
    let host = rest.split('/').next().filter(|h| !h.is_empty())?;
    Some(format!("{scheme}://{host}"))
}

/// A repository id (`r` and 20 hex digits) anywhere in `url`.
pub fn repo_in(url: &str) -> Option<String> {
    url.split(['/', ':', '.'])
        .find(|p| {
            p.len() == 21 && p.starts_with('r') && p[1..].bytes().all(|b| b.is_ascii_hexdigit())
        })
        .map(str::to_owned)
}

fn config_dir() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .map(|d| d.join("yoneda"))
}

fn stored(path: &Path) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let origin = value["origin"].as_str()?.trim_end_matches('/').to_owned();
    let token = value["token"]
        .as_str()
        .filter(|t| !t.is_empty())?
        .to_owned();
    Some((origin, token))
}

fn stored_login() -> Option<(String, String)> {
    let dir = config_dir()?;
    match std::env::var("YONEDA_AGENT") {
        Ok(agent) if !agent.is_empty() => {
            stored(&dir.join("agents").join(agent).join("credentials"))
        }
        _ => stored(&dir.join("credentials")),
    }
}

/// The caller's cloud credential for `origin`: `YONEDA_TOKEN`, else the stored login whose
/// origin is `origin`.
pub fn token_for(origin: &str) -> Option<String> {
    if let Ok(token) = std::env::var("YONEDA_TOKEN")
        && !token.is_empty()
    {
        return Some(token);
    }
    stored_login()
        .filter(|(o, _)| o == origin.trim_end_matches('/'))
        .map(|(_, t)| t)
}

/// The origin to create a cloud repository on when the clone has none: `YONEDA_ORIGIN`,
/// else the stored login's. There is no built-in default.
pub fn account_origin() -> Option<String> {
    std::env::var("YONEDA_ORIGIN")
        .ok()
        .filter(|o| !o.is_empty())
        .map(|o| o.trim_end_matches('/').to_owned())
        .or_else(|| stored_login().map(|(o, _)| o))
}

/// Runs `git -C <dir> <args>` against the cloud: only this binary's helper supplies the
/// credential (every other helper is cleared, so nothing is stored in a keychain), and
/// Git never prompts.
pub fn git(dir: &Path, origin: &str, args: &[&str]) -> Result<Output> {
    let exe =
        std::env::current_exe().map_err(|e| local_error(format!("Cannot find myself: {e}")))?;
    let helper = format!(
        "credential.helper=!'{}' credential cloud",
        exe.display().to_string().replace('\'', r"'\''")
    );
    Command::new(crate::store::git_bin())
        .arg("-C")
        .arg(dir)
        .args(["-c", "credential.helper=", "-c", &helper])
        .args(args)
        .env(CLOUD_ENV, origin)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| local_error(format!("Cannot run git: {e}")))
}

/// Creates a private repository named `name` on `origin` with no required checks or
/// approvals (as `yoneda repo create` does) and answers its id.
pub fn create_repo(origin: &str, token: &str, name: &str) -> Result<String> {
    let body = json!({ "name": name, "visibility": "private",
                       "policy": { "approvals": 0, "required_checks": [] } });
    let answer = reqwest::blocking::Client::new()
        .post(format!("{origin}/api/v1/repos"))
        .bearer_auth(token)
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .map_err(|e| local_error(format!("Cannot reach {origin}: {}", e.without_url())))?;
    let status = answer.status();
    let value: Value = answer.json().unwrap_or(Value::Null);
    if !status.is_success() {
        let why = value["error"]["message"]
            .as_str()
            .or(value["error"].as_str())
            .unwrap_or("refused");
        return Err(local_error(format!(
            "Creating the cloud repository failed ({status}): {why}"
        )));
    }
    value["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| local_error("The platform returned no repository id"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_and_ids_come_from_every_remote_form() {
        let id = "r0123456789abcdef0123";
        for url in [
            format!("yoneda::https://api.dev.yonedarepo.com/{id}"),
            format!("https://api.dev.yonedarepo.com/git/{id}.git"),
            format!("yoneda::https://api.dev.yonedarepo.com/api/v1/repos/{id}"),
        ] {
            assert_eq!(
                origin_of(&url).as_deref(),
                Some("https://api.dev.yonedarepo.com")
            );
            assert_eq!(repo_in(&url).as_deref(), Some(id));
        }
        assert_eq!(
            origin_of("http://127.0.0.1:8787/git/x.git").as_deref(),
            Some("http://127.0.0.1:8787")
        );
        assert_eq!(origin_of("git@github.com:a/b.git"), None);
    }
}
