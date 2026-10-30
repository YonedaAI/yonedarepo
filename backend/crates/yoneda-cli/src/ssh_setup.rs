//! `yoneda ssh setup`: one command from "signed in" to `git clone ssh://…`. It uses or makes
//! `~/.ssh/id_ed25519`, adds the public key to the account, routes the platform's SSH host
//! through cloudflared in `~/.ssh/config` (a marked block, nothing else touched), offers the
//! public key on the clipboard and tries `ssh -T`. The private key is never read or printed.
mod config;
mod key;
mod tools;

use crate::api::{Api, Failure};
use crate::error::{Error, Result};
use crate::{credentials, human, note, output, ssh_key_cmd, target};
use serde_json::Value;
use std::path::Path;

/// A host name as the platform may send it. It goes into a config file that runs commands, so
/// the block is built from this checked name, never from the platform's `ssh_config` text.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// A key API refusal; a login from before the SSH keys scope, or one narrowed on the approval
/// page, is told what works.
fn refused(failure: Failure, origin: &str) -> Error {
    let forbidden = failure.code == "FORBIDDEN";
    let mut error = Error::from(failure);
    if forbidden {
        error.message = format!(
            "Run `yoneda login --origin {origin}` again, then `yoneda ssh setup`: this token \
             cannot manage SSH keys ({})",
            error.message
        );
    }
    error
}

/// A whole `git clone` line: this account's first repository, else the shape of one.
async fn clone_line(api: &Api, host: &str) -> String {
    let listed = api.get("/repos").await.ok();
    let repo = listed.as_ref().and_then(|l| l["repos"].get(0));
    match repo.and_then(|r| Some((r["id"].as_str()?, r["name"].as_str()?))) {
        Some((id, name)) => format!("git clone ssh://git@{host}/{id}.git {name}"),
        None => format!("git clone ssh://git@{host}/<repository id>.git"),
    }
}

/// Writes the tunnel's block; a front door that plain `ssh` reaches directly needs none.
fn route(ssh: &Value, ssh_dir: &Path, host: &str) -> Result<Route> {
    if ssh["ssh_config"].is_null() {
        human!("{host} needs no ~/.ssh/config entry");
        return Ok(Route::default());
    }
    let cloudflared = tools::cloudflared();
    let program = match &cloudflared {
        Some(path) => config::proxy_program(&path.display().to_string(), cfg!(windows)),
        None => {
            note!(
                "cloudflared was not found: run the install command again (it fetches cloudflared), then `yoneda ssh setup`. Until then the entry expects cloudflared on PATH."
            );
            "cloudflared".to_owned()
        }
    };
    let path = ssh_dir.join("config");
    let changed = config::install(&path, host, &program)?;
    human!(
        "{} {host} in {}",
        if changed { "Routed" } else { "Already routed" },
        path.display()
    );
    Ok(Route {
        config: Some(path),
        cloudflared,
        changed,
    })
}

/// How `ssh` reaches the host, as written to `~/.ssh/config`.
#[derive(Default)]
struct Route {
    config: Option<std::path::PathBuf>,
    cloudflared: Option<std::path::PathBuf>,
    changed: bool,
}

pub async fn run(origin: Option<&str>) -> Result<()> {
    let (origin, api) = target::account_api(origin)?;
    let listed = api
        .get("/ssh-keys")
        .await
        .map_err(|f| refused(f, &origin))?;
    let ssh = &listed["ssh"];
    let Some(host) = ssh["host"].as_str().filter(|h| valid_host(h)) else {
        return Err(Error::new(
            "Git over SSH is not open on this platform yet; use HTTPS with a token meanwhile",
        ));
    };

    let ssh_dir = credentials::home_dir()?.join(".ssh");
    let local = key::ensure(&ssh_dir)?;
    let public = ssh_key_cmd::public_key(&local.contents)?;
    let fingerprint = key::fingerprint(&public.line)?;
    let present = listed["keys"].as_array().is_some_and(|keys| {
        keys.iter()
            .any(|k| k["fingerprint"] == fingerprint.as_str())
    });
    if present {
        human!("{fingerprint} is already on your account");
    } else {
        ssh_key_cmd::add(&api, &public, None)
            .await
            .map_err(|f| refused(f, &origin))?;
        human!("Added {fingerprint} to your account");
    }

    let route = route(ssh, &ssh_dir, host)?;
    let clipboard = tools::copy(&local.contents);
    match clipboard {
        Some(tool) => human!("Your public key, copied to the clipboard with {tool}:"),
        None => human!("Your public key (no clipboard tool found, so not copied):"),
    }
    human!("{}", local.contents);

    // Without cloudflared the tunnel cannot answer, so the check would only say that again.
    let check = (route.cloudflared.is_some() || route.config.is_none())
        .then(|| tools::check(route.config.as_deref(), host))
        .flatten();
    match &check {
        Some(check) if check.passed => human!("ssh -T git@{host}: {}", check.output),
        Some(check) => note!("ssh -T git@{host} did not pass: {}", check.output),
        None => {}
    }
    let clone = clone_line(&api, host).await;
    human!("Clone: {clone}");

    output::emit(&output::SshSetup {
        key_path: local.path.display().to_string(),
        public_key: local.contents.clone(),
        generated: local.generated,
        fingerprint,
        already_added: present,
        ssh_host: host.to_owned(),
        cloudflared: route.cloudflared.map(|p| p.display().to_string()),
        config_path: route.config.map(|p| p.display().to_string()),
        config_changed: route.changed,
        clipboard: clipboard.map(str::to_owned),
        check_passed: check.as_ref().map(|c| c.passed),
        check_output: check.map(|c| c.output),
        clone,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_host;

    #[test]
    fn only_plain_host_names_reach_the_config_file() {
        for good in [
            "ssh.yonedarepo.com",
            "ssh.dev.yonedarepo.com",
            "a-1.example",
        ] {
            assert!(valid_host(good), "{good}");
        }
        for bad in [
            "",
            "x\n  ProxyCommand evil",
            "a b",
            "Host",
            "a;b",
            "a\"b",
            "*",
        ] {
            assert!(!valid_host(bad), "{bad:?}");
        }
    }
}
