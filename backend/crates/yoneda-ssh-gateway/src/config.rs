//! Configuration from the environment the container (or a local run) is started with:
//! `PLATFORM_URL`, `SSH_LISTEN`, `HEALTH_LISTEN` (optional), `SSH_GATEWAY_SECRET` and the
//! host keys `SSH_HOST_ED25519_KEY` (required) and `SSH_HOST_ECDSA_KEY` (OpenSSH private
//! key files, unencrypted, as is or base64-encoded on one line). With `TUNNEL_TOKEN`, it also
//! runs cloudflared (the Cloudflare Tunnel front door, tunnel.rs). Host keys come from secrets so they survive every deploy.
use russh::keys::{Algorithm, PrivateKey};
use std::net::SocketAddr;

pub struct Config {
    pub platform_url: String,
    pub ssh_listen: SocketAddr,
    pub health_listen: Option<SocketAddr>,
    pub secret: Vec<u8>,
    pub host_keys: Vec<PrivateKey>,
    /// cloudflared to run beside the gateway: set when `TUNNEL_TOKEN` is (the Cloudflare
    /// Tunnel front door); `CLOUDFLARED` names another binary (local runs).
    pub cloudflared: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("{0} is invalid: {1}")]
    Invalid(&'static str, String),
}

impl Config {
    pub fn from_env() -> Result<Config, ConfigError> {
        Config::from_lookup(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError> {
        let required = |name: &'static str| get(name).ok_or(ConfigError::Missing(name));
        let address = |name: &'static str, value: String| {
            value
                .parse::<SocketAddr>()
                .map_err(|e| ConfigError::Invalid(name, e.to_string()))
        };
        let platform_url = required("PLATFORM_URL")?;
        if !(platform_url.starts_with("http://") || platform_url.starts_with("https://")) {
            return Err(ConfigError::Invalid(
                "PLATFORM_URL",
                "not an http(s) URL".into(),
            ));
        }
        let secret = required("SSH_GATEWAY_SECRET")?;
        if secret.len() < 32 {
            return Err(ConfigError::Invalid(
                "SSH_GATEWAY_SECRET",
                "shorter than 32 characters".into(),
            ));
        }
        let mut host_keys = vec![crate::host_key::parse(
            "SSH_HOST_ED25519_KEY",
            &required("SSH_HOST_ED25519_KEY")?,
            |a| matches!(a, Algorithm::Ed25519),
        )?];
        if let Some(ecdsa) = get("SSH_HOST_ECDSA_KEY") {
            host_keys.push(crate::host_key::parse("SSH_HOST_ECDSA_KEY", &ecdsa, |a| {
                matches!(a, Algorithm::Ecdsa { .. })
            })?);
        }
        Ok(Config {
            platform_url,
            ssh_listen: address(
                "SSH_LISTEN",
                get("SSH_LISTEN").unwrap_or("0.0.0.0:2222".into()),
            )?,
            health_listen: get("HEALTH_LISTEN")
                .map(|v| address("HEALTH_LISTEN", v))
                .transpose()?,
            secret: secret.into_bytes(),
            host_keys,
            cloudflared: get("TUNNEL_TOKEN")
                .map(|_| get("CLOUDFLARED").unwrap_or(crate::tunnel::CLOUDFLARED.into())),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::collections::HashMap;

    /// A fixed test host key, made at test time (no key material in the source).
    fn ed25519() -> String {
        let pair = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[7; 32]);
        PrivateKey::from(pair)
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap()
            .to_string()
    }

    fn config(vars: &[(&str, String)]) -> Result<Config, ConfigError> {
        let mut env: HashMap<String, String> = [
            ("PLATFORM_URL", "http://platform.internal".to_owned()),
            ("SSH_GATEWAY_SECRET", "s".repeat(32)),
            ("SSH_HOST_ED25519_KEY", ed25519()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        for (k, v) in vars {
            env.insert((*k).to_owned(), v.clone());
        }
        Config::from_lookup(|name| env.get(name).cloned())
    }

    #[test]
    fn host_keys_load_as_files_or_base64_and_never_echo() {
        let loaded = config(&[]).unwrap();
        assert_eq!(loaded.host_keys.len(), 1);
        assert_eq!(loaded.ssh_listen.port(), 2222);
        let encoded = STANDARD.encode(ed25519());
        assert_eq!(
            config(&[("SSH_HOST_ED25519_KEY", encoded)])
                .unwrap()
                .host_keys
                .len(),
            1
        );
        // An Ed25519 key is not an ECDSA host key, and errors never contain the key.
        let wrong = config(&[("SSH_HOST_ECDSA_KEY", ed25519())]).err().unwrap();
        assert!(!wrong.to_string().contains("b3BlbnNzaC"), "{wrong}");
        assert!(config(&[("SSH_HOST_ED25519_KEY", "garbage".into())]).is_err());
        assert!(config(&[("SSH_GATEWAY_SECRET", "short".into())]).is_err());
        assert!(config(&[("PLATFORM_URL", "ftp://x".into())]).is_err());
        // cloudflared runs only with a tunnel token.
        assert_eq!(loaded.cloudflared, None);
        let tunnel = config(&[("TUNNEL_TOKEN", "t".into())]).unwrap();
        assert_eq!(
            tunnel.cloudflared.as_deref(),
            Some(crate::tunnel::CLOUDFLARED)
        );
    }
}
