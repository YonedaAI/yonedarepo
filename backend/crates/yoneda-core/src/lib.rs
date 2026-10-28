//! Core contracts: the Git object model, Git transport codecs, the transaction log, merge,
//! derived data (blame, search, text diff), account identifiers and the error and digest
//! primitives.
//!
//! Everything here is pure: no I/O, clock, randomness or Cloudflare dependency. Callers pass
//! bytes, JSON and time in and get values or a contextual [`Error`] back, so the same rules
//! run in the Durable Object, the stateless Worker compute, the CLI and native tests.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub mod account;
pub mod git_object;
pub mod transport;
pub mod txlog;
/// MCP tools of the source platform (`/api/v1/repos/:id/mcp`), named after Git verbs.
pub const PLATFORM_MCP_TOOLS: &str = include_str!("platform_tools.json");
/// Provider registry shared with the TypeScript side through `shared/`; this JSON is the
/// single source of truth.
pub const PROVIDER_REGISTRY: &str = include_str!("provider_registry.json");
pub mod blame;
pub mod merge;
#[cfg(test)]
mod merge_tree_tests;
pub mod search;
pub mod textdiff;

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, thiserror::Error)]
#[error("{code}: {message}")]
pub struct Error {
    pub code: String,
    pub message: String,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;

pub fn validate_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 512
        || path.starts_with('/')
        || path.contains(['\\', '\0', ':'])
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
    {
        return Err(Error::new(
            "UNSAFE_PATH",
            format!("Unsupported source path: {path:?}"),
        ));
    }
    Ok(())
}
/// Lowercase hex of raw bytes (digest outputs no longer implement `LowerHex` in sha2 0.11).
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}
pub fn fingerprint(value: &Value) -> Result<String> {
    fn canonical(v: &Value) -> Result<Value> {
        Ok(match v {
            Value::Object(m) => {
                let ordered: BTreeMap<_, _> = m
                    .iter()
                    .map(|(k, v)| Ok((k.clone(), canonical(v)?)))
                    .collect::<Result<_>>()?;
                serde_json::to_value(ordered).map_err(|e| Error::new("ENCODING", e.to_string()))?
            }
            Value::Array(a) => Value::Array(a.iter().map(canonical).collect::<Result<_>>()?),
            Value::Number(n) if n.is_f64() => {
                return Err(Error::new("ENCODING", "Fingerprints forbid floating point"));
            }
            _ => v.clone(),
        })
    }
    let mut bytes = b"yonedarepo:json:v1\0".to_vec();
    bytes.extend(
        serde_json::to_vec(&canonical(value)?)
            .map_err(|e| Error::new("ENCODING", e.to_string()))?,
    );
    Ok(digest(&bytes))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn platform_tools_are_git_verbs_with_closed_object_schemas() {
        let tools: Vec<serde_json::Value> = serde_json::from_str(PLATFORM_MCP_TOOLS).unwrap();
        assert!(tools.len() >= 10);
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            assert!(
                name.starts_with("git_") || name.starts_with("symbol_"),
                "{name}"
            );
            assert!(!tool["description"].as_str().unwrap().is_empty());
            assert_eq!(tool["inputSchema"]["type"], "object");
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
        }
    }
    #[test]
    fn provider_registry_entries_carry_the_required_contract_keys() {
        let providers: Vec<serde_json::Value> = serde_json::from_str(PROVIDER_REGISTRY).unwrap();
        assert!(!providers.is_empty());
        for provider in &providers {
            for key in [
                "id",
                "name",
                "harness",
                "protocol",
                "api_base",
                "default_model",
                "models",
            ] {
                assert!(provider.get(key).is_some(), "{key} missing in {provider:?}");
            }
        }
    }
    #[test]
    fn safe_paths_are_allowed_and_archive_escapes_are_rejected() {
        assert!(validate_path("src/retry.rs").is_ok());
        for path in [
            "../key",
            "/etc/passwd",
            "a/../../x",
            ".git/config",
            "a/.git/hooks/x",
            "a\\b",
            "a//b",
            "a/./b",
            "",
            "a\0b",
        ] {
            assert!(validate_path(path).is_err(), "{path:?}");
        }
    }
    #[test]
    fn evidence_hash_matches_standard_sha256() {
        assert_eq!(
            digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
    #[test]
    fn fingerprints_ignore_object_key_order_but_not_input_changes() {
        assert_eq!(
            fingerprint(&json!({"a":1,"b":2})).unwrap(),
            fingerprint(&json!({"b":2,"a":1})).unwrap()
        );
        assert_ne!(
            fingerprint(&json!({"a":1})).unwrap(),
            fingerprint(&json!({"a":2})).unwrap()
        );
        assert!(fingerprint(&json!({"score": 0.5})).is_err());
    }
}
