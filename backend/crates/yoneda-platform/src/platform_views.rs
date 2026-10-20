//! The human view (paper §7.2): a subsystem narrative and dependency map generated from
//! one revision's tree, symbols, contracts and symbol graph. Templates only — no model
//! calls — so the view is deterministic and works with every agent service down.
use crate::platform_narrative::{Stats, label, language, narrative};
use crate::platform_symbol_graph::{Graph, Node, RESOLUTION};
use crate::storage::bad;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use yoneda_core::Result;

const MAX_EDGES: usize = 500;

fn trimmed(path: &str) -> &str {
    path.trim_matches('/')
}

/// The subsystem a file belongs to: its directory, cut to one level below `focus`.
fn unit(file: &str, depth: usize) -> String {
    let dir: Vec<&str> = file.split('/').collect();
    let dir = &dir[..dir.len().saturating_sub(1)];
    dir[..dir.len().min(depth + 1)].join("/")
}

fn inside(unit: &str, focus: &str) -> bool {
    focus.is_empty() || unit == focus || unit.starts_with(&format!("{focus}/"))
}

/// Human view of the subsystems under `path` (default: the repository root).
pub fn human_view(c: &Value) -> Result<Value> {
    let graph = Graph::build(c)?;
    let focus = trimmed(c["path"].as_str().unwrap_or_default());
    if focus.split('/').any(|p| p == "..") {
        return Err(bad("path must be a directory inside the repository"));
    }
    let depth = if focus.is_empty() {
        0
    } else {
        focus.split('/').count()
    };
    let units: Vec<String> = graph.files.iter().map(|f| unit(f.path, depth)).collect();
    let mut stats: BTreeMap<String, Stats> = BTreeMap::new();
    for (fi, file) in graph.files.iter().enumerate() {
        if !inside(&units[fi], focus) {
            continue;
        }
        let s = stats.entry(units[fi].clone()).or_default();
        s.files.insert(file.path.to_owned());
        *s.languages.entry(language(file.path)).or_default() += 1;
        if file.parse_error.is_some() {
            s.parse_errors.push(file.path.to_owned());
        }
        for (si, symbol) in file.symbols.iter().enumerate() {
            *s.kinds
                .entry(symbol["kind"].as_str().unwrap_or("symbol").to_owned())
                .or_default() += 1;
            s.symbols.push((fi, si));
        }
    }
    let mut incoming: BTreeMap<Node, usize> = BTreeMap::new();
    let mut unit_edges: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut file_edges: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    for e in &graph.edges {
        *incoming.entry(e.to).or_default() += 1;
        let (from, to) = (&units[e.from.0], &units[e.to.0]);
        if from != to && (stats.contains_key(from) || stats.contains_key(to)) {
            *unit_edges.entry((from.clone(), to.clone())).or_default() += 1;
            if let Some(s) = stats.get_mut(to) {
                *s.used_by.entry(from.clone()).or_default() += 1;
                *s.entry.entry(e.to).or_default() += 1;
            }
            if let Some(s) = stats.get_mut(from) {
                *s.depends_on.entry(to.clone()).or_default() += 1;
            }
        }
        let (ff, tf) = (graph.files[e.from.0].path, graph.files[e.to.0].path);
        if ff != tf && stats.contains_key(from) && stats.contains_key(to) {
            *file_edges.entry((ff, tf)).or_default() += 1;
        }
    }
    let subsystems: Vec<Value> = stats
        .iter()
        .map(|(name, s)| {
            let (paragraphs, contracts) = narrative(name, s, &graph, &incoming);
            json!({ "path": name, "files": s.files.len(), "symbols": s.symbols.len(),
                "languages": s.languages, "kinds": s.kinds, "parse_errors": s.parse_errors,
                "used_by": s.used_by, "depends_on": s.depends_on, "contracts": contracts,
                "narrative": paragraphs })
        })
        .collect();
    let mut nodes: BTreeMap<String, bool> = stats.keys().map(|k| (k.clone(), true)).collect();
    for (from, to) in unit_edges.keys() {
        nodes.entry(from.clone()).or_insert(false);
        nodes.entry(to.clone()).or_insert(false);
    }
    let edge_list = |edges: Vec<(String, String, usize)>| {
        let truncated = edges.len() > MAX_EDGES;
        let list: Vec<Value> = edges
            .into_iter()
            .take(MAX_EDGES)
            .map(|(f, t, n)| json!({"from": f, "to": t, "references": n}))
            .collect();
        (list, truncated)
    };
    let (edges, edges_truncated) = edge_list(
        unit_edges
            .into_iter()
            .map(|((f, t), n)| (f, t, n))
            .collect(),
    );
    let (files, files_truncated) = edge_list(
        file_edges
            .into_iter()
            .map(|((f, t), n)| (f.to_owned(), t.to_owned(), n))
            .collect(),
    );
    Ok(json!({
        "path": focus,
        "subsystems": subsystems,
        "dependency_map": {
            "nodes": nodes.iter().map(|(id, inside)| json!({"id": id, "label": label(id).trim_matches('`'), "inside": inside})).collect::<Vec<_>>(),
            "edges": edges,
            "file_edges": files,
            "truncated": edges_truncated || files_truncated,
        },
        "resolution": RESOLUTION,
        "files_analyzed": graph.files.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sym(name: &str, start: u64, refs: &[&str], summary: Option<&str>) -> Value {
        json!({"name": name, "symbol_path": name, "kind": "function", "start": start, "end": start + 5,
            "start_line": 1, "digest": format!("d-{name}"), "refs": refs,
            "contract": {"summary": summary, "inputs": [], "outputs": [], "effects": [], "errors": [], "invariants": []}})
    }

    #[test]
    fn narrates_subsystems_and_maps_dependencies_deterministically() {
        let input = json!({
            "files": [
                {"path": "src/net/retry.rs", "facts": {"symbols": [sym("retry", 0, &["sleep"], Some("Retries an operation."))]}},
                {"path": "src/util/time.rs", "facts": {"symbols": [sym("sleep", 0, &[], None)]}},
                {"path": "src/main.rs", "facts": {"symbols": [sym("main", 0, &["retry"], None)]}},
                {"path": "web/app.ts", "facts": {"symbols": [], "parse_error": "Syntax error"}},
            ],
            "records": [{"path": "src/net/retry.rs", "symbol_path": "retry", "seq": 1, "node_digest": "old",
                "contract": {"summary": "outdated"}}],
        });
        let root = human_view(&input).unwrap();
        let names: Vec<&str> = root["subsystems"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["path"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["src", "web"]);
        assert!(
            root["subsystems"][1]["narrative"][0]
                .as_str()
                .unwrap()
                .contains("could not be parsed")
        );
        let src = human_view(
            &json!({"path": "src", "files": input["files"], "records": input["records"]}),
        )
        .unwrap();
        let net = src["subsystems"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["path"] == "src/net")
            .unwrap();
        let text = net["narrative"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            text.contains("`src/net` holds 1 source file (1 Rust) with 1 symbol: 1 function."),
            "{text}"
        );
        assert!(
            text.contains("Most referenced: `retry` (1 reference): Retries an operation."),
            "{text}"
        );
        assert!(
            text.contains("Used by `src` (1 reference). Entry points from outside: `retry`."),
            "{text}"
        );
        assert!(
            text.contains("Depends on `src/util` (1 reference)."),
            "{text}"
        );
        assert!(
            text.contains("1 stale because the symbol changed"),
            "{text}"
        );
        assert_eq!(net["contracts"]["stale"], 1);
        assert_eq!(
            src["dependency_map"]["edges"],
            json!([
                {"from": "src", "to": "src/net", "references": 1},
                {"from": "src/net", "to": "src/util", "references": 1},
            ])
        );
        assert_eq!(human_view(&input).unwrap(), root, "deterministic");
    }
}
