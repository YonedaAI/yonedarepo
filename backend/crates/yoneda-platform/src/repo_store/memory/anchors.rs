//! Memory anchors: a file (`symbol_path` empty), a symbol in a file (`path` +
//! `symbol_path`), or a `dir/` prefix, at most 20 per memory. A file anchor carries the
//! file's blob at the memory's commit and a symbol anchor the symbol's node digest there,
//! both resolved by the adapter; a directory anchor carries neither.
use crate::storage::bad;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::Result;

const MAX_ANCHORS: usize = 20;
const MAX_SYMBOL: usize = 512;

/// One anchor: a file (`symbol_path` empty), a symbol in a file, or a `dir/` prefix.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Anchor {
    pub path: String,
    pub symbol_path: String,
    pub blob: Option<String>,
    pub node_digest: Option<String>,
}

impl Anchor {
    pub fn is_dir(&self) -> bool {
        self.path.ends_with('/')
    }

    pub fn from_row(row: &Value) -> Self {
        let text = |key: &str| row[key].as_str().map(str::to_owned);
        Self {
            path: text("path").unwrap_or_default(),
            symbol_path: text("symbol_path").unwrap_or_default(),
            blob: text("blob"),
            node_digest: text("node_digest"),
        }
    }

    pub fn json(&self, stale: Option<bool>) -> Value {
        json!({ "path": self.path,
                "symbol_path": (!self.symbol_path.is_empty()).then_some(&self.symbol_path),
                "blob": self.blob, "node_digest": self.node_digest, "stale": stale })
    }
}

fn hex(text: &str, len: usize) -> bool {
    text.len() == len
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn optional_hex(a: &Value, key: &str, len: usize) -> Result<Option<String>> {
    match &a[key] {
        Value::Null => Ok(None),
        Value::String(s) if hex(s, len) => Ok(Some(s.clone())),
        _ => Err(bad(&format!(
            "anchor {key} must be {len} lowercase hex digits"
        ))),
    }
}

/// Validates a file path or a `dir/` prefix.
pub fn anchor_path(path: &str) -> Result<()> {
    yoneda_core::validate_path(path.strip_suffix('/').unwrap_or(path))
}

pub fn anchors(c: &Value) -> Result<Vec<Anchor>> {
    let list = match &c["anchors"] {
        Value::Null => return Ok(Vec::new()),
        Value::Array(list) if list.len() <= MAX_ANCHORS => list,
        _ => {
            return Err(bad(&format!(
                "anchors must be a list of at most {MAX_ANCHORS} {{path, symbol_path?}}"
            )));
        }
    };
    let mut out = BTreeSet::new();
    for a in list {
        let path = a["path"]
            .as_str()
            .ok_or_else(|| bad("Each anchor needs a path"))?;
        anchor_path(path)?;
        let symbol_path = match &a["symbol_path"] {
            Value::Null => String::new(),
            Value::String(s)
                if !s.is_empty() && s.len() <= MAX_SYMBOL && !s.contains(char::is_control) =>
            {
                s.clone()
            }
            _ => return Err(bad("anchor symbol_path must be 1-512 characters")),
        };
        let anchor = Anchor {
            path: path.to_owned(),
            symbol_path,
            blob: optional_hex(a, "blob", 40)?,
            node_digest: optional_hex(a, "node_digest", 64)?,
        };
        if anchor.is_dir() && (!anchor.symbol_path.is_empty() || anchor.blob.is_some()) {
            return Err(bad("A directory anchor names no symbol or blob"));
        }
        out.insert(anchor);
    }
    Ok(out.into_iter().collect())
}
