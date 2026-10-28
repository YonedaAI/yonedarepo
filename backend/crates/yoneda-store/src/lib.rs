//! The synchronous SQL store contract shared by every Durable Object authority (source
//! repositories, commit shards, accounts), with its native SQLite implementation for tests and
//! local tools. JSON in, JSON out; no Cloudflare dependency.
use serde_json::Value;
use yoneda_core::{Error, Result};

#[cfg(feature = "native")]
pub mod native;

/// The most parameters one statement may bind: Durable Object SQLite refuses more ("too
/// many SQL variables"; developers.cloudflare.com/durable-objects/platform/limits). A list
/// of unbounded length is bound as one JSON array (`IN (SELECT value FROM json_each(?))`)
/// or in chunks below this.
pub const MAX_BOUND_PARAMETERS: usize = 100;

pub trait SqlStore: Clone + 'static {
    fn query(&self, sql: &str, params: &[Value]) -> Result<Vec<Value>>;
    fn transaction(&self, action: Box<dyn FnOnce() -> Result<Value>>) -> Result<Value>;
}

pub fn bad(message: &str) -> Error {
    Error::new("INVALID_INPUT", message)
}

/// A short, non-blank string field (at most 16 KiB).
pub fn string(v: &Value, key: &str) -> Result<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 16384)
        .map(str::to_owned)
        .ok_or_else(|| bad(&format!("Missing or invalid {key}")))
}

pub fn number(v: &Value, key: &str) -> Result<i64> {
    v.get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad(&format!("Missing or invalid {key}")))
}
