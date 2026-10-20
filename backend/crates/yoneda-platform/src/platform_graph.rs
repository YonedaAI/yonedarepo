//! Symbol structure beyond the flat index: which symbols nest in which, each symbol's
//! own text (its range minus nested symbols), the symbols a file's changes touched, and
//! the reference graph (identifiers in a symbol's own text that name other symbols).
//! References resolve by name, so the graph over-approximates; that only ever joins or
//! orders more work, never less.
use crate::platform_symbols::{Language, Symbol, extract, language};
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::txlog::{SymbolGraph, SymbolNode};

/// `parent[i]`: the innermost symbol whose range strictly contains symbol `i`.
fn parents(symbols: &[Symbol]) -> Vec<Option<usize>> {
    let mut order: Vec<usize> = (0..symbols.len()).collect();
    order.sort_by_key(|&i| (symbols[i].start, std::cmp::Reverse(symbols[i].end), i));
    let mut parent = vec![None; symbols.len()];
    let mut open: Vec<usize> = Vec::new();
    for i in order {
        // Sorted by start, so an open symbol contains `i` unless it ends first; equal
        // ranges (`export const a = 1, b = 2`) are siblings, not nested.
        let same =
            |o: usize| (symbols[o].start, symbols[o].end) == (symbols[i].start, symbols[i].end);
        while open
            .last()
            .is_some_and(|&o| symbols[o].end < symbols[i].end || same(o))
        {
            open.pop();
        }
        parent[i] = open.last().copied();
        open.push(i);
    }
    parent
}

/// Byte ranges of `range` not covered by its direct children, in order.
fn own_pieces(range: (usize, usize), children: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut pieces = Vec::new();
    let mut at = range.0;
    for &(start, end) in children {
        pieces.push((at, start.max(at)));
        at = at.max(end);
    }
    pieces.push((at, range.1.max(at)));
    pieces
}

/// A region's own text with whitespace at symbol boundaries ignored: the trimmed,
/// non-empty pieces between direct children. Moving, adding or removing a child never
/// changes it; any other edit outside the children does.
fn skeleton(source: &str, range: (usize, usize), children: &[(usize, usize)]) -> Vec<String> {
    own_pieces(range, children)
        .into_iter()
        .filter_map(|(s, e)| source.get(s..e))
        .map(str::trim)
        .filter(|piece| !piece.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Per qualified path, the skeletons of every occurrence (overloads, repeated impls),
/// plus the file's own top-level skeleton.
fn shape(source: &str, symbols: &[Symbol]) -> (Vec<String>, BTreeMap<String, Vec<Vec<String>>>) {
    let parent = parents(symbols);
    let children_of = |p: Option<usize>| -> Vec<(usize, usize)> {
        let mut c: Vec<(usize, usize)> = (0..symbols.len())
            .filter(|&i| parent[i] == p)
            .map(|i| (symbols[i].start, symbols[i].end))
            .collect();
        c.sort_unstable();
        c
    };
    let top = skeleton(source, (0, source.len()), &children_of(None));
    let mut each: BTreeMap<String, Vec<Vec<String>>> = BTreeMap::new();
    for (i, symbol) in symbols.iter().enumerate() {
        let own = skeleton(source, (symbol.start, symbol.end), &children_of(Some(i)));
        each.entry(symbol.symbol_path.clone())
            .or_default()
            .push(own);
    }
    (top, each)
}

/// Symbols a modification touched, or `None` when it must count as the whole file:
/// either side fails to parse, or text outside every symbol changed.
pub fn touched(path: &str, old: &str, new: &str) -> Option<Vec<String>> {
    language(path)?;
    let (old_symbols, new_symbols) = (extract(path, old).ok()?, extract(path, new).ok()?);
    let (old_top, old_each) = shape(old, &old_symbols);
    let (new_top, new_each) = shape(new, &new_symbols);
    if old_top != new_top {
        return None;
    }
    let names: BTreeSet<&String> = old_each.keys().chain(new_each.keys()).collect();
    let changed: Vec<String> = names
        .into_iter()
        .filter(|name| old_each.get(*name) != new_each.get(*name))
        .cloned()
        .collect();
    (!changed.is_empty()).then_some(changed)
}

/// Identifier tokens with their byte offsets; comments and string literals excluded.
fn identifiers(path: &str, source: &str) -> Result<Vec<(usize, String)>, String> {
    match language(path) {
        Some(Language::Rust) => {
            let result = source
                .parse::<proc_macro2::TokenStream>()
                .map_err(|e| e.to_string())
                .map(|stream| {
                    let mut out = Vec::new();
                    rust_idents(stream, &mut out);
                    out
                });
            // See platform_symbols: span-locations state must not outlive the call.
            proc_macro2::extra::invalidate_current_thread_spans();
            result
        }
        Some(Language::Script) => script_idents(path, source),
        None => Err("Unsupported language".into()),
    }
}

fn rust_idents(stream: proc_macro2::TokenStream, out: &mut Vec<(usize, String)>) {
    for token in stream {
        match token {
            proc_macro2::TokenTree::Ident(ident) => {
                out.push((ident.span().byte_range().start, ident.to_string()));
            }
            proc_macro2::TokenTree::Group(group) => rust_idents(group.stream(), out),
            _ => {}
        }
    }
}

fn script_idents(path: &str, source: &str) -> Result<Vec<(usize, String)>, String> {
    use oxc_allocator::Allocator;
    use oxc_parser::{Parser, config::TokensParserConfig};
    use oxc_span::SourceType;
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(path).map_err(|e| format!("{e:?}"))?;
    let parsed = Parser::new(&allocator, source, source_type)
        .with_config(TokensParserConfig)
        .parse();
    if parsed.fatal_error || parsed.diagnostics.has_errors() {
        return Err("Syntax error".into());
    }
    Ok(parsed
        .tokens
        .iter()
        .filter(|t| t.kind().is_identifier_name())
        .filter_map(|t| {
            let (start, end) = (t.start() as usize, t.end() as usize);
            source.get(start..end).map(|text| (start, text.to_owned()))
        })
        .collect())
}

/// One parsed file's symbols and, per symbol, the identifiers in its own text.
pub struct FileSymbols {
    pub path: String,
    pub symbols: Vec<Symbol>,
    pub references: Vec<BTreeSet<String>>,
}

pub fn file_symbols(path: &str, source: &str) -> Result<FileSymbols, String> {
    let symbols = extract(path, source)?;
    let mut references = vec![BTreeSet::new(); symbols.len()];
    for (offset, name) in identifiers(path, source)? {
        // The innermost symbols containing the identifier own it (several when they
        // share one range).
        let containing = |i: &usize| symbols[*i].start <= offset && offset < symbols[*i].end;
        let Some(width) = (0..symbols.len())
            .filter(containing)
            .map(|i| symbols[i].end - symbols[i].start)
            .min()
        else {
            continue;
        };
        for i in (0..symbols.len())
            .filter(containing)
            .filter(|&i| symbols[i].end - symbols[i].start == width)
        {
            references[i].insert(name.clone());
        }
    }
    Ok(FileSymbols {
        path: path.into(),
        symbols,
        references,
    })
}

/// One node per (file, qualified path); an edge wherever a symbol's own text names
/// another symbol (any symbol with that name, in any file of the graph).
pub fn graph(files: &[FileSymbols], coarse: BTreeSet<String>) -> SymbolGraph {
    let mut index: BTreeMap<(&str, &str), usize> = BTreeMap::new();
    let mut nodes = Vec::new();
    let mut by_name: BTreeMap<&str, BTreeSet<usize>> = BTreeMap::new();
    for file in files {
        for symbol in &file.symbols {
            let id = *index
                .entry((&file.path, &symbol.symbol_path))
                .or_insert_with(|| {
                    nodes.push(SymbolNode {
                        path: file.path.clone(),
                        symbol: symbol.symbol_path.clone(),
                    });
                    nodes.len() - 1
                });
            by_name.entry(&symbol.name).or_default().insert(id);
        }
    }
    let mut edges: Vec<BTreeSet<usize>> = vec![BTreeSet::new(); nodes.len()];
    for file in files {
        for (symbol, names) in file.symbols.iter().zip(&file.references) {
            let from = index[&(file.path.as_str(), symbol.symbol_path.as_str())];
            for name in names {
                for &to in by_name.get(name.as_str()).into_iter().flatten() {
                    if to != from {
                        edges[from].insert(to);
                    }
                }
            }
        }
    }
    SymbolGraph {
        nodes,
        edges: edges.into_iter().map(|e| e.into_iter().collect()).collect(),
        coarse,
    }
}

#[cfg(test)]
mod tests;
