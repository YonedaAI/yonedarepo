//! The symbol graph over one revision, assembled from per-file facts the adapter supplies
//! (only files the caller may read), and the agent view built on it: a symbol, its
//! contract and its graph neighbors. References resolve lexically by name: a local
//! definition wins, and a name with more than `MAX_CANDIDATES` definitions is too generic
//! to resolve. Edges are therefore candidates, never type-checked facts.
use crate::platform_contracts::resolve;
use crate::storage::{bad, string};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::{Error, Result};

const MAX_CANDIDATES: usize = 3;
const MAX_NEIGHBORS: usize = 100;
pub const RESOLUTION: &str = "lexical: identifiers matched to definitions by name";

pub struct File<'a> {
    pub path: &'a str,
    pub symbols: &'a [Value],
    pub parse_error: Option<&'a str>,
}

/// A symbol: (file index, symbol index).
pub type Node = (usize, usize);

pub struct Edge {
    pub from: Node,
    pub to: Node,
    /// The name had more than one candidate definition.
    pub ambiguous: bool,
}

pub struct Graph<'a> {
    pub files: Vec<File<'a>>,
    pub edges: Vec<Edge>,
    records: BTreeMap<(&'a str, &'a str), Vec<Value>>,
}

fn range(s: &Value) -> (u64, u64) {
    (
        s["start"].as_u64().unwrap_or_default(),
        s["end"].as_u64().unwrap_or_default(),
    )
}

fn related(a: &Value, b: &Value) -> bool {
    let ((a0, a1), (b0, b1)) = (range(a), range(b));
    (a0 <= b0 && b1 <= a1) || (b0 <= a0 && a1 <= b1)
}

impl<'a> Graph<'a> {
    pub fn build(c: &'a Value) -> Result<Self> {
        let listed = c["files"]
            .as_array()
            .ok_or_else(|| bad("files must be a list"))?;
        let files: Vec<File<'a>> = listed
            .iter()
            .map(|f| {
                Ok(File {
                    path: f["path"].as_str().ok_or_else(|| bad("file path missing"))?,
                    symbols: f["facts"]["symbols"].as_array().map_or(&[], Vec::as_slice),
                    parse_error: f["facts"]["parse_error"].as_str(),
                })
            })
            .collect::<Result<_>>()?;
        let mut records: BTreeMap<(&str, &str), Vec<Value>> = BTreeMap::new();
        for r in c["records"].as_array().into_iter().flatten() {
            if let (Some(path), Some(symbol)) = (r["path"].as_str(), r["symbol_path"].as_str()) {
                records.entry((path, symbol)).or_default().push(r.clone());
            }
        }
        for list in records.values_mut() {
            list.sort_by_key(|r| r["seq"].as_i64());
        }
        let mut defs: BTreeMap<&str, Vec<Node>> = BTreeMap::new();
        for (fi, file) in files.iter().enumerate() {
            for (si, s) in file.symbols.iter().enumerate() {
                match s["name"].as_str() {
                    Some(name) if name != "default" => defs.entry(name).or_default().push((fi, si)),
                    _ => {}
                }
            }
        }
        let mut edges = Vec::new();
        for (fi, file) in files.iter().enumerate() {
            for (si, s) in file.symbols.iter().enumerate() {
                for name in s["refs"].as_array().into_iter().flatten() {
                    let Some(found) = name.as_str().and_then(|n| defs.get(n)) else {
                        continue;
                    };
                    let candidates: Vec<Node> = found
                        .iter()
                        .copied()
                        .filter(|&(tf, ts)| !(tf == fi && related(s, &files[tf].symbols[ts])))
                        .collect();
                    let local: Vec<Node> =
                        candidates.iter().copied().filter(|n| n.0 == fi).collect();
                    let targets = if local.is_empty() { candidates } else { local };
                    if targets.len() > MAX_CANDIDATES {
                        continue;
                    }
                    let ambiguous = targets.len() > 1;
                    edges.extend(targets.into_iter().map(|to| Edge {
                        from: (fi, si),
                        to,
                        ambiguous,
                    }));
                }
            }
        }
        Ok(Self {
            files,
            edges,
            records,
        })
    }

    pub fn symbol(&self, node: Node) -> &'a Value {
        &self.files[node.0].symbols[node.1]
    }

    /// The governing contract of a symbol (authored, derived, or stale).
    pub fn contract(&self, node: Node) -> Value {
        let symbol = self.symbol(node);
        let key = (
            self.files[node.0].path,
            symbol["symbol_path"].as_str().unwrap_or_default(),
        );
        resolve(symbol, self.records.get(&key).map_or(&[], Vec::as_slice))
    }

    pub fn find(&self, path: &str, symbol: &str) -> Option<Node> {
        let fi = self.files.iter().position(|f| f.path == path)?;
        let symbols = self.files[fi].symbols;
        symbols
            .iter()
            .position(|s| s["symbol_path"] == symbol)
            .or_else(|| symbols.iter().position(|s| s["name"] == symbol))
            .map(|si| (fi, si))
    }

    fn neighbor(&self, node: Node, ambiguous: bool) -> Value {
        let s = self.symbol(node);
        json!({ "path": self.files[node.0].path, "symbol_path": s["symbol_path"], "kind": s["kind"],
            "start": s["start"], "end": s["end"], "start_line": s["start_line"],
            "digest": s["digest"], "ambiguous": ambiguous })
    }
}

/// Neighbors of one side of `node`'s edges, deduplicated and in a stable order.
fn neighbors(graph: &Graph, node: Node, incoming: bool) -> (Vec<Value>, bool) {
    let mut seen: BTreeMap<Node, bool> = BTreeMap::new();
    for e in &graph.edges {
        let (here, there) = if incoming {
            (e.to, e.from)
        } else {
            (e.from, e.to)
        };
        if here == node && there != node {
            *seen.entry(there).or_default() |= e.ambiguous;
        }
    }
    let truncated = seen.len() > MAX_NEIGHBORS;
    let list = seen
        .into_iter()
        .take(MAX_NEIGHBORS)
        .map(|(n, ambiguous)| graph.neighbor(n, ambiguous))
        .collect();
    (list, truncated)
}

/// The symbol named by `path` and `symbol`, refusing files that do not parse.
fn focus(graph: &Graph, c: &Value) -> Result<Node> {
    let path = string(c, "path")?;
    let symbol = string(c, "symbol")?;
    if let Some(error) = graph
        .files
        .iter()
        .find(|f| f.path == path)
        .and_then(|f| f.parse_error)
    {
        return Err(Error::new(
            "PARSE_FAILED",
            format!("{path} does not parse: {error}"),
        ));
    }
    graph
        .find(&path, &symbol)
        .ok_or_else(|| Error::new("NOT_FOUND", format!("{symbol} is not a symbol of {path}")))
}

/// A symbol without its internal facts, labelled with its file.
fn public_symbol(graph: &Graph, node: Node) -> Value {
    let mut symbol = graph.symbol(node).clone();
    if let Some(map) = symbol.as_object_mut() {
        map.remove("refs");
        map.remove("contract");
        map.insert("path".into(), json!(graph.files[node.0].path));
    }
    symbol
}

/// One symbol's governing contract (`files` may hold just the symbol's file).
pub fn contract_view(c: &Value) -> Result<Value> {
    let graph = Graph::build(c)?;
    let node = focus(&graph, c)?;
    let mut view = graph.contract(node);
    view["symbol"] = public_symbol(&graph, node);
    Ok(view)
}

/// Agent view: one symbol with its contract and its callers and callees.
pub fn agent_view(c: &Value) -> Result<Value> {
    let graph = Graph::build(c)?;
    let node = focus(&graph, c)?;
    let (callers, callers_truncated) = neighbors(&graph, node, true);
    let (callees, callees_truncated) = neighbors(&graph, node, false);
    let s = graph.symbol(node);
    let members: Vec<Value> = graph.files[node.0]
        .symbols
        .iter()
        .enumerate()
        .filter(|(i, m)| *i != node.1 && range(s).0 <= range(m).0 && range(m).1 <= range(s).1)
        .map(|(i, _)| graph.neighbor((node.0, i), false))
        .collect();
    Ok(json!({
        "symbol": public_symbol(&graph, node),
        "contract": graph.contract(node),
        "neighbors": { "callers": callers, "callees": callees, "members": members,
            "truncated": callers_truncated || callees_truncated },
        "resolution": RESOLUTION,
        "files_analyzed": graph.files.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(name: &str, path: &str, start: u64, end: u64, refs: &[&str]) -> Value {
        json!({"name": name, "symbol_path": path, "kind": "function", "start": start, "end": end,
            "start_line": 1, "digest": format!("d-{path}"), "contract": {}, "refs": refs})
    }

    #[test]
    fn resolves_local_first_skips_generic_names_and_reports_neighbors() {
        let input = json!({
            "path": "a.rs", "symbol": "run",
            "files": [
                {"path": "a.rs", "facts": {"symbols": [
                    sym("run", "run", 0, 50, &["helper", "get", "Shared"]),
                    sym("helper", "helper", 60, 80, &[]),
                ]}},
                {"path": "b.rs", "facts": {"symbols": [
                    sym("helper", "helper", 0, 10, &[]),
                    sym("main", "main", 20, 40, &["run"]),
                    sym("Shared", "Shared", 50, 60, &[]),
                ]}},
                {"path": "c.rs", "facts": {"symbols": [
                    sym("get", "A::get", 0, 1, &[]), sym("get", "B::get", 2, 3, &[]),
                    sym("get", "C::get", 4, 5, &[]), sym("get", "D::get", 6, 7, &[]),
                ]}},
            ],
            "records": [],
        });
        let view = agent_view(&input).unwrap();
        let callees: Vec<(&str, &str)> = view["neighbors"]["callees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| {
                (
                    n["path"].as_str().unwrap(),
                    n["symbol_path"].as_str().unwrap(),
                )
            })
            .collect();
        // The local helper wins over b.rs's; `get` has four definitions and is skipped.
        assert_eq!(callees, [("a.rs", "helper"), ("b.rs", "Shared")]);
        assert_eq!(view["neighbors"]["callers"][0]["symbol_path"], "main");
        assert_eq!(view["contract"]["status"], "derived");
        assert!(view["symbol"].get("refs").is_none());
        let missing =
            agent_view(&json!({"path": "a.rs", "symbol": "nope", "files": input["files"]}));
        assert_eq!(missing.unwrap_err().code, "NOT_FOUND");
    }
}
