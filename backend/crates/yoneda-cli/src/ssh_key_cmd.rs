//! `yoneda ssh-key …`: the account's SSH public keys, for Git over SSH. The platform
//! parses and fingerprints a key; this reads it, catches the usual mistakes (a private key,
//! a file of several keys) before sending, and prints what the platform answers.
use crate::api::{Api, Failure, encode};
use crate::command::SshKeyCommand;
use crate::error::{Context, Error, Result};
use crate::human;
use crate::output::{self, SshKey};
use crate::target;
use serde_json::{Value, json};
use std::io::Read;

/// The longest title the CLI derives from a key comment or host name.
const TITLE_CHARS: usize = 64;

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("?")
}

/// A field for `--json` (empty when absent, where the human text shows `?`).
fn owned(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

/// One OpenSSH public key line (`<type> <base64> [comment]`) and its comment.
#[derive(Debug, PartialEq, Eq)]
pub struct PublicKey {
    pub line: String,
    pub comment: Option<String>,
}

/// Parses the contents of a `.pub` file: exactly one key, never a private key.
pub fn public_key(contents: &str) -> Result<PublicKey> {
    if contents.contains("PRIVATE KEY") {
        return Err(Error::new(
            "That is a private key: pass the .pub file next to it (never share the private key)",
        ));
    }
    let lines: Vec<&str> = contents
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    let [line] = lines[..] else {
        return Err(Error::new(format!(
            "Expected one public key line, found {}",
            lines.len()
        )));
    };
    let mut parts = line.split_whitespace();
    let (Some(kind), Some(body)) = (parts.next(), parts.next()) else {
        return Err(Error::new(
            "Not an OpenSSH public key (expected `<type> <base64> [comment]`)",
        ));
    };
    if !(kind.starts_with("ssh-") || kind.starts_with("ecdsa-") || kind.starts_with("sk-")) {
        return Err(Error::new(format!("Unsupported key type {kind:?}")));
    }
    let comment = parts.collect::<Vec<_>>().join(" ");
    Ok(PublicKey {
        line: format!("{kind} {body}"),
        comment: (!comment.is_empty()).then_some(comment),
    })
}

/// The title for a key: `--title`, else its comment, else this host's name.
pub fn default_title(title: Option<String>, key: &PublicKey, host: Option<String>) -> String {
    title
        .or_else(|| key.comment.clone())
        .or(host)
        .map(|t| t.chars().take(TITLE_CHARS).collect::<String>())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "ssh key".into())
}

pub(crate) fn host_name() -> Option<String> {
    std::env::var("HOSTNAME")
        .ok()
        .or_else(|| {
            let out = std::process::Command::new("hostname").output().ok()?;
            String::from_utf8(out.stdout).ok()
        })
        .map(|h| h.trim().to_owned())
        .filter(|h| !h.is_empty())
}

fn read_source(source: &str) -> Result<String> {
    if source == "-" {
        let mut contents = String::new();
        std::io::stdin()
            .read_to_string(&mut contents)
            .context("reading the public key from stdin")?;
        return Ok(contents);
    }
    std::fs::read_to_string(source).context(format!("reading {source}"))
}

/// A millisecond timestamp as its UTC date (`YYYY-MM-DD`), or `never`.
fn when(value: &Value) -> String {
    let Some(ms) = value.as_i64() else {
        return "never".into();
    };
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Adds `key` to the account as `title` (see [`default_title`]); the platform's answer.
pub async fn add(
    api: &Api,
    key: &PublicKey,
    title: Option<String>,
) -> std::result::Result<Value, Failure> {
    let title = default_title(title, key, host_name());
    api.post("/ssh-keys", &json!({ "title": title, "key": key.line }))
        .await
}

/// How to use the key, from the platform's `ssh` answer: on the Cloudflare Tunnel front door,
/// `yoneda ssh setup` once (or the entry by hand); then the clone command.
pub fn setup(ssh: &Value) -> String {
    let Some(host) = ssh["host"].as_str() else {
        return "Git over SSH is not open on this platform yet; use HTTPS with a token meanwhile."
            .into();
    };
    let clone = format!("Then: git clone ssh://git@{host}/<repository id>.git");
    match ssh["ssh_config"].as_str() {
        Some(config) => format!(
            "Git over SSH goes through Cloudflare Tunnel. Once per machine, run `yoneda ssh setup`,\n\
             or install cloudflared and add to ~/.ssh/config:\n\n{}\n{clone}",
            config
                .lines()
                .map(|l| format!("    {l}\n"))
                .collect::<String>()
        ),
        None => clone,
    }
}

pub async fn run(origin: Option<&str>, command: SshKeyCommand) -> Result<()> {
    let (_, api) = target::account_api(origin)?;
    match command {
        SshKeyCommand::Add { source, title } => {
            let key = public_key(&read_source(&source)?)?;
            let added = add(&api, &key, title).await?;
            human!(
                "Added {} {}  {}",
                text(&added["id"]),
                text(&added["fingerprint"]),
                text(&added["title"])
            );
            human!("{}", setup(&added["ssh"]));
            output::emit(&output::SshKeyAdd {
                id: owned(&added["id"]),
                fingerprint: owned(&added["fingerprint"]),
                title: owned(&added["title"]),
                ssh_host: added["ssh"]["host"].as_str().map(str::to_owned),
                ssh_config: added["ssh"]["ssh_config"].as_str().map(str::to_owned),
            });
        }
        SshKeyCommand::List => {
            let keys = api.get("/ssh-keys").await?["keys"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if keys.is_empty() {
                human!("No SSH keys (add one with: yoneda ssh-key add ~/.ssh/id_ed25519.pub)");
            }
            for k in &keys {
                human!(
                    "{}  {}  {}  last used {}",
                    text(&k["id"]),
                    text(&k["fingerprint"]),
                    text(&k["title"]),
                    when(&k["last_used_at"])
                );
            }
            let keys = keys
                .iter()
                .map(|k| SshKey {
                    id: owned(&k["id"]),
                    fingerprint: owned(&k["fingerprint"]),
                    title: owned(&k["title"]),
                    last_used_at: k["last_used_at"].as_i64(),
                })
                .collect();
            output::emit(&output::SshKeyList { keys });
        }
        SshKeyCommand::Remove { id } => {
            api.delete(&format!("/ssh-keys/{}", encode(&id))).await?;
            human!("Removed SSH key {id}; Git over SSH with it stops at once");
            output::emit(&output::SshKeyRemove { id });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    #[test]
    fn reads_one_public_key_and_its_comment() {
        let key = public_key(&format!("{KEY} alice@laptop\n")).unwrap();
        assert_eq!(key.line, KEY);
        assert_eq!(key.comment.as_deref(), Some("alice@laptop"));
        let bare = public_key(&format!("# a comment line\n\n{KEY}\n")).unwrap();
        assert_eq!(bare.comment, None);
        let spaced = public_key(&format!("{KEY} work  key")).unwrap();
        assert_eq!(spaced.comment.as_deref(), Some("work key"));
    }

    #[test]
    fn refuses_private_keys_several_keys_and_garbage() {
        let private =
            "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n";
        assert!(
            public_key(private)
                .unwrap_err()
                .message
                .contains("private key")
        );
        assert!(public_key(&format!("{KEY}\n{KEY}\n")).is_err());
        assert!(public_key("").is_err());
        assert!(public_key("ssh-ed25519").is_err());
        assert!(public_key("pgp-key AAAA").is_err());
    }

    #[test]
    fn setup_prints_the_tunnel_ssh_config_and_the_clone_command() {
        let tunnel = json!({
            "front_door": "tunnel", "host": "ssh.yonedarepo.com",
            "ssh_config": "Host ssh.yonedarepo.com\n  ProxyCommand cloudflared access ssh --hostname %h\n",
        });
        let printed = setup(&tunnel);
        assert!(printed.contains("yoneda ssh setup"), "{printed}");
        assert!(printed.contains(
            "    Host ssh.yonedarepo.com\n      ProxyCommand cloudflared access ssh --hostname %h\n"
        ));
        assert!(printed.ends_with("git clone ssh://git@ssh.yonedarepo.com/<repository id>.git"));
        let direct = setup(
            &json!({"front_door": "connect", "host": "ssh.yonedarepo.com", "ssh_config": null}),
        );
        assert_eq!(
            direct,
            "Then: git clone ssh://git@ssh.yonedarepo.com/<repository id>.git"
        );
        assert!(setup(&json!({"host": null})).contains("not open"));
        assert!(setup(&Value::Null).contains("not open"));
    }

    #[test]
    fn last_use_prints_as_a_utc_date() {
        assert_eq!(when(&Value::Null), "never");
        assert_eq!(when(&json!(0)), "1970-01-01");
        assert_eq!(when(&json!(1_793_145_600_000_i64)), "2026-10-28");
        assert_eq!(when(&json!(951_782_400_000_i64)), "2000-02-29");
    }

    #[test]
    fn titles_come_from_the_flag_then_the_comment_then_the_host() {
        let with = public_key(&format!("{KEY} alice@laptop")).unwrap();
        let without = public_key(KEY).unwrap();
        let host = || Some("build-box".to_owned());
        assert_eq!(default_title(Some("ci".into()), &with, host()), "ci");
        assert_eq!(default_title(None, &with, host()), "alice@laptop");
        assert_eq!(default_title(None, &without, host()), "build-box");
        assert_eq!(default_title(None, &without, None), "ssh key");
        assert_eq!(
            default_title(Some("x".repeat(100)), &without, None).len(),
            64
        );
    }
}
