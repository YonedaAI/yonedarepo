//! Per-file code facts for contracts and views: every symbol with its node digest, the
//! contract derived from its signature and doc comments, and the identifiers it
//! references. Facts depend only on a blob's content and language, so the adapter caches
//! them by blob id. References are lexical (identifier tokens), not type-resolved.
use crate::platform_code::text_blob;
use crate::platform_contracts::Contract;
use crate::platform_facts_rust::rust_facts;
use crate::platform_symbols::{Language, Symbol, extract, language};
use crate::storage::string;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use yoneda_core::Result;

/// Bump when the table's shape or derivation changes, so cached tables are not reused.
pub const FACTS_VERSION: u32 = 1;
const MAX_REFS: usize = 400;

/// A contract derived for the declaration whose name token starts at `offset`.
pub(crate) type Derived = (usize, String, Contract);
/// An identifier token: byte offset and text.
pub(crate) type Token = (usize, String);

/// Files a revision-wide view analyses, so view cost stays bounded on large trees.
pub const MAX_VIEW_FILES: usize = 400;

/// The files of a tree listing (`files`: `{path, id, type}`) that views analyse: regular
/// files in a supported language, in path order, at most `MAX_VIEW_FILES`.
pub fn view_files(c: &Value) -> Result<Value> {
    let listed = c["files"]
        .as_array()
        .ok_or_else(|| crate::storage::bad("files must be a list"))?;
    let mut chosen: Vec<&Value> = listed
        .iter()
        .filter(|f| matches!(f["type"].as_str(), Some("blob" | "exec")))
        .filter(|f| f["path"].as_str().and_then(language).is_some())
        .collect();
    chosen.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
    let truncated = chosen.len() > MAX_VIEW_FILES;
    chosen.truncate(MAX_VIEW_FILES);
    let files: Vec<Value> = chosen
        .into_iter()
        .map(|f| json!({ "path": f["path"], "id": f["id"] }))
        .collect();
    Ok(json!({ "files": files, "truncated": truncated, "limit": MAX_VIEW_FILES }))
}

pub fn code_facts(c: &Value) -> Result<Value> {
    let path = string(c, "path")?;
    let (id, source) = match text_blob(c, "id") {
        Err(e) if e.code == "NEED_BLOB" => return Ok(json!({ "need_blobs": [e.message] })),
        other => other?,
    };
    let lang = language(&path);
    let base =
        json!({ "path": path, "id": id, "supported": lang.is_some(), "facts": FACTS_VERSION });
    let parsed = extract(&path, &source).and_then(|symbols| {
        let (derived, tokens) = match lang {
            Some(Language::Rust) => rust_facts(&source)?,
            Some(Language::Script) => crate::platform_facts_script::facts(&path, &source)?,
            None => (Vec::new(), Vec::new()),
        };
        Ok(table(&source, &symbols, &derived, &tokens))
    });
    let mut out = base;
    match parsed {
        Ok(symbols) => out["symbols"] = json!(symbols),
        Err(error) => {
            out["parse_error"] = json!(error);
            out["symbols"] = json!([]);
        }
    }
    Ok(out)
}

/// The innermost symbol whose range contains `offset` (and has `name`, when given).
fn innermost(symbols: &[Symbol], offset: usize, name: Option<&str>) -> Option<usize> {
    symbols
        .iter()
        .enumerate()
        .filter(|(_, s)| s.start <= offset && offset < s.end)
        .filter(|(_, s)| name.is_none_or(|n| s.name == n))
        .min_by_key(|(_, s)| s.end - s.start)
        .map(|(i, _)| i)
}

fn table(source: &str, symbols: &[Symbol], derived: &[Derived], tokens: &[Token]) -> Vec<Value> {
    let mut contracts: Vec<Contract> = vec![Contract::default(); symbols.len()];
    for (offset, name, contract) in derived {
        if let Some(i) = innermost(symbols, *offset, Some(name)) {
            contracts[i] = contract.clone();
        }
    }
    let mut refs: Vec<BTreeSet<&str>> = vec![BTreeSet::new(); symbols.len()];
    for (offset, name) in tokens {
        if let Some(i) = innermost(symbols, *offset, None)
            && symbols[i].name != *name
            && refs[i].len() < MAX_REFS
        {
            refs[i].insert(name);
        }
    }
    symbols
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let mut value = json!(s);
            value["digest"] = json!(yoneda_core::digest(&source.as_bytes()[s.start..s.end]));
            value["contract"] = json!(contracts[i]);
            value["refs"] = json!(refs[i]);
            value
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(path: &str, source: &str) -> Vec<Value> {
        let symbols = extract(path, source).unwrap();
        let (derived, tokens) = match language(path) {
            Some(Language::Rust) => rust_facts(source).unwrap(),
            _ => crate::platform_facts_script::facts(path, source).unwrap(),
        };
        table(source, &symbols, &derived, &tokens)
    }

    #[test]
    fn rust_contracts_come_from_signatures_and_rustdoc() {
        let source = "/// Retries an operation.\n///\n/// # Errors\n/// - when every attempt fails\n///\n/// # Panics\n/// If `times` is zero.\npub fn retry(times: u32, log: &mut Vec<String>) -> Result<u32, RetryError> {\n    helper(times)\n}\n\nfn helper(n: u32) -> u32 { n }\n\n/// A retry budget.\npub struct Policy {\n    /// Attempts left.\n    pub left: u32,\n}\n\nimpl Policy {\n    pub async fn spend(&mut self) -> bool { helper(1) > 0 }\n}\n";
        let table = facts("src/lib.rs", source);
        let retry = &table[0];
        assert_eq!(retry["contract"]["summary"], "Retries an operation.");
        assert_eq!(
            retry["contract"]["inputs"],
            json!([{"name": "times", "type": "u32"}, {"name": "log", "type": "&mut Vec<String>"}])
        );
        assert_eq!(
            retry["contract"]["outputs"],
            json!([{"type": "Result<u32, RetryError>"}])
        );
        assert_eq!(
            retry["contract"]["errors"],
            json!([
                {"kind": "error", "type": "RetryError", "description": "when every attempt fails"},
                {"kind": "panic", "description": "If `times` is zero."}
            ])
        );
        assert_eq!(retry["contract"]["effects"], json!(["mutates log"]));
        assert!(retry["refs"].as_array().unwrap().contains(&json!("helper")));
        let policy = table.iter().find(|s| s["symbol_path"] == "Policy").unwrap();
        assert_eq!(
            policy["contract"]["inputs"],
            json!([{"name": "left", "type": "u32", "description": "Attempts left."}])
        );
        let spend = table
            .iter()
            .find(|s| s["symbol_path"] == "Policy::spend")
            .unwrap();
        assert_eq!(
            spend["contract"]["effects"],
            json!(["mutates self", "async"])
        );
        assert_eq!(spend["refs"], json!(["bool", "helper"]));
    }

    #[test]
    fn parse_failures_are_reported_not_empty() {
        let c = json!({"path": "a.rs", "id": yoneda_core::git_object::hash_object(yoneda_core::git_object::ObjectKind::Blob, b"fn (").hex(),
            "blobs": {yoneda_core::git_object::hash_object(yoneda_core::git_object::ObjectKind::Blob, b"fn (").hex(): "Zm4gKA=="}});
        let out = code_facts(&c).unwrap();
        assert!(out["parse_error"].is_string());
        assert_eq!(out["symbols"], json!([]));
    }
}
