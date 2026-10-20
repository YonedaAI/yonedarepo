//! Narrative templates for the human view (see `platform_views`): one subsystem's files,
//! symbols, key symbols, dependencies and contract health as plain sentences.
use crate::platform_symbol_graph::{Graph, Node};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const KEY_SYMBOLS: usize = 5;
const ENTRY_POINTS: usize = 8;

pub(crate) fn label(unit: &str) -> String {
    if unit.is_empty() {
        "(top level)".into()
    } else {
        format!("`{unit}`")
    }
}

fn plural(n: usize, one: &str) -> String {
    let word = if n == 1 {
        one.to_owned()
    } else if one.ends_with('s') || one.ends_with('x') {
        format!("{one}es")
    } else {
        format!("{one}s")
    };
    format!("{n} {word}")
}

/// "a, b and c".
fn listing(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

pub(crate) fn language(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e) {
        Some("rs") => "Rust",
        Some("ts" | "tsx" | "mts" | "cts") => "TypeScript",
        _ => "JavaScript",
    }
}

#[derive(Default)]
pub(crate) struct Stats {
    pub(crate) files: BTreeSet<String>,
    pub(crate) languages: BTreeMap<&'static str, usize>,
    pub(crate) kinds: BTreeMap<String, usize>,
    pub(crate) parse_errors: Vec<String>,
    pub(crate) symbols: Vec<Node>,
    pub(crate) used_by: BTreeMap<String, usize>,
    pub(crate) depends_on: BTreeMap<String, usize>,
    pub(crate) entry: BTreeMap<Node, usize>,
}

fn counts(map: &BTreeMap<String, usize>) -> Vec<(String, usize)> {
    let mut list: Vec<(String, usize)> = map.iter().map(|(k, v)| (k.clone(), *v)).collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    list
}

fn summary_of(contract: &Value) -> Option<String> {
    let governing = if contract["status"] == "stale" {
        &contract["derived"]
    } else {
        &contract["contract"]
    };
    // Templates add their own punctuation.
    governing["summary"]
        .as_str()
        .map(|s| s.trim_end_matches('.').to_owned())
}

pub(crate) fn narrative(
    name: &str,
    s: &Stats,
    graph: &Graph,
    incoming: &BTreeMap<Node, usize>,
) -> (Vec<String>, Value) {
    let mut paragraphs = Vec::new();
    let langs: Vec<String> = s
        .languages
        .iter()
        .map(|(l, n)| format!("{n} {l}"))
        .collect();
    let kinds: Vec<String> = counts(&s.kinds)
        .iter()
        .map(|(k, n)| plural(*n, k))
        .collect();
    let mut opening = format!(
        "{} holds {} ({}) with {}",
        label(name),
        plural(s.files.len(), "source file"),
        langs.join(", "),
        plural(s.symbols.len(), "symbol"),
    );
    if !kinds.is_empty() {
        opening.push_str(&format!(": {}", listing(&kinds)));
    }
    opening.push('.');
    if !s.parse_errors.is_empty() {
        opening.push_str(&format!(
            " {} could not be parsed and contributes no symbols: {}.",
            plural(s.parse_errors.len(), "file"),
            listing(
                &s.parse_errors
                    .iter()
                    .map(|p| format!("`{p}`"))
                    .collect::<Vec<_>>()
            )
        ));
    }
    paragraphs.push(opening);
    let mut key: Vec<(Node, usize)> = s
        .symbols
        .iter()
        .map(|n| (*n, incoming.get(n).copied().unwrap_or(0)))
        .filter(|(_, c)| *c > 0)
        .collect();
    key.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let key: Vec<String> = key
        .iter()
        .take(KEY_SYMBOLS)
        .map(|(n, c)| {
            let symbol = graph.symbol(*n)["symbol_path"].as_str().unwrap_or_default();
            match summary_of(&graph.contract(*n)) {
                Some(summary) => format!("`{symbol}` ({}): {summary}", plural(*c, "reference")),
                None => format!("`{symbol}` ({})", plural(*c, "reference")),
            }
        })
        .collect();
    if !key.is_empty() {
        paragraphs.push(format!("Most referenced: {}.", key.join("; ")));
    }
    let edges = |map: &BTreeMap<String, usize>| {
        counts(map)
            .iter()
            .map(|(u, n)| format!("{} ({})", label(u), plural(*n, "reference")))
            .collect::<Vec<_>>()
    };
    let mut entry: Vec<(Node, usize)> = s.entry.iter().map(|(n, c)| (*n, *c)).collect();
    entry.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let entry: Vec<String> = entry
        .iter()
        .take(ENTRY_POINTS)
        .map(|(n, _)| {
            format!(
                "`{}`",
                graph.symbol(*n)["symbol_path"].as_str().unwrap_or_default()
            )
        })
        .collect();
    paragraphs.push(if s.used_by.is_empty() {
        "Nothing else in the readable tree references it.".into()
    } else {
        format!(
            "Used by {}. Entry points from outside: {}.",
            listing(&edges(&s.used_by)),
            listing(&entry)
        )
    });
    paragraphs.push(if s.depends_on.is_empty() {
        "It depends on no other subsystem.".into()
    } else {
        format!("Depends on {}.", listing(&edges(&s.depends_on)))
    });
    let (mut authored, mut stale, mut derived, mut silent, mut failures) = (0, Vec::new(), 0, 0, 0);
    for n in &s.symbols {
        let contract = graph.contract(*n);
        match contract["status"].as_str() {
            Some("authored") => authored += 1,
            Some("stale") => stale.push(format!(
                "`{}`",
                graph.symbol(*n)["symbol_path"].as_str().unwrap_or_default()
            )),
            _ if contract["contract"].as_object().is_some_and(|c| {
                c.values()
                    .any(|v| v.as_array().is_none_or(|a| !a.is_empty()))
            }) =>
            {
                derived += 1
            }
            _ => silent += 1,
        }
        let governing = if contract["status"] == "stale" {
            &contract["derived"]
        } else {
            &contract["contract"]
        };
        failures += governing["errors"].as_array().map_or(0, Vec::len);
    }
    let mut contracts = format!(
        "Contracts: {} authored, {} derived from signatures and doc comments, {} with nothing stated",
        authored, derived, silent
    );
    if !stale.is_empty() {
        contracts.push_str(&format!(
            "; {} stale because the symbol changed after its contract was recorded ({})",
            stale.len(),
            listing(&stale)
        ));
    }
    contracts.push_str(&format!(". {} declared.", plural(failures, "failure mode")));
    paragraphs.push(contracts);
    let stats = json!({ "authored": authored, "derived": derived, "unstated": silent,
        "stale": stale.len(), "failure_modes": failures });
    (paragraphs, stats)
}
