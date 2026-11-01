//! `--json` results of `yoneda memory`.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `memory add`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryAdd {
    /// The memory's id.
    pub memory: Value,
    /// Its kind as stored: one short lowercase word.
    pub kind: String,
    /// The commit it was written against.
    pub commit: String,
    /// Whether the same memory was recorded already (this answers that one).
    pub already: bool,
}

/// `memory list`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryList {
    /// The memories newest first, as the platform returns them (with anchors and staleness).
    pub memories: Vec<Value>,
    /// The kinds to pick from: the built-in ones, then those this repository added.
    pub kinds: Vec<String>,
    /// The `before` cursor of the next page, when more remain.
    pub next: Value,
}

/// `memory show`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryShow {
    /// The memory as the platform returns it.
    pub memory: Value,
}

/// `memory retire`.
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryRetire {
    pub memory: u64,
    /// Whether it was retired already.
    pub already: bool,
}

super::report! {
    MemoryAdd => "memory-add",
    MemoryList => "memory-list",
    MemoryShow => "memory-show",
    MemoryRetire => "memory-retire",
}
