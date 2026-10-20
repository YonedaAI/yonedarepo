//! Read and write set entries at path or symbol granularity. An entry is a file path, a
//! `dir/` prefix, or `path#symbol_path` naming a symbol from the platform's symbol index
//! (`src/lib.rs#Policy::backoff`). A symbol covers its nested members. Anything that is
//! not resolved to symbols stays a whole path, so "unknown" never reads as disjoint.
use super::overlaps;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    /// A file or `dir/` prefix, covering everything inside it.
    Path(String),
    /// One symbol of one file and its nested members.
    Symbol { path: String, symbol: String },
}

/// `ident(::ident)*`, where an identifier may carry Rust's `r#` raw prefix.
fn is_symbol_path(text: &str) -> bool {
    !text.is_empty()
        && text.split("::").all(|segment| {
            let name = segment.strip_prefix("r#").unwrap_or(segment);
            let mut chars = name.chars();
            chars
                .next()
                .is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$')
                && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
        })
}

/// `a` covers `b` or `b` covers `a`: equal, or one is a `::` ancestor of the other.
pub fn symbols_overlap(a: &str, b: &str) -> bool {
    let within = |inner: &str, outer: &str| {
        inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with("::"))
    };
    a == b || within(a, b) || within(b, a)
}

impl Access {
    /// Splits at the first `#` whose right side is a symbol path; otherwise a path.
    pub fn parse(entry: &str) -> Access {
        for (index, _) in entry.match_indices('#') {
            let (path, symbol) = (&entry[..index], &entry[index + 1..]);
            if !path.is_empty() && !path.ends_with('/') && is_symbol_path(symbol) {
                return Access::Symbol {
                    path: path.into(),
                    symbol: symbol.into(),
                };
            }
        }
        Access::Path(entry.into())
    }

    pub fn path(&self) -> &str {
        match self {
            Access::Path(path) | Access::Symbol { path, .. } => path,
        }
    }

    /// The same entry at path granularity.
    pub fn coarse(&self) -> Access {
        Access::Path(self.path().into())
    }

    pub fn overlaps(&self, other: &Access) -> bool {
        match (self, other) {
            (Access::Path(a), Access::Path(b)) => overlaps(a, b),
            // The spelled-out entry is also compared as a path, so a file whose name merely
            // looks like `path#symbol` is never mistaken for a disjoint symbol.
            (Access::Path(a), symbol @ Access::Symbol { path, .. })
            | (symbol @ Access::Symbol { path, .. }, Access::Path(a)) => {
                overlaps(a, path) || overlaps(a, &symbol.to_string())
            }
            (Access::Symbol { path: p, symbol: s }, Access::Symbol { path: q, symbol: t }) => {
                p == q && symbols_overlap(s, t)
            }
        }
    }
}

impl fmt::Display for Access {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Access::Path(path) => f.write_str(path),
            Access::Symbol { path, symbol } => write!(f, "{path}#{symbol}"),
        }
    }
}

/// The symbols one change touched in one file, derived by the platform from the diff
/// (never declared by a client). A file without one counts as written in full.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymbolTouch {
    pub path: String,
    pub symbols: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccessSet(BTreeSet<Access>);

impl AccessSet {
    pub fn parse<I, S>(entries: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        Self(
            entries
                .into_iter()
                .map(|e| Access::parse(e.as_ref()))
                .collect(),
        )
    }

    /// A change's writes: each written path, narrowed to the derived symbols when the
    /// platform resolved them. An empty refinement stays a whole-file write.
    pub fn writes<'a>(paths: impl IntoIterator<Item = &'a str>, refined: &[SymbolTouch]) -> Self {
        let mut set = BTreeSet::new();
        for path in paths {
            match refined
                .iter()
                .find(|r| r.path == path && !r.symbols.is_empty())
            {
                Some(touch) => set.extend(touch.symbols.iter().map(|symbol| Access::Symbol {
                    path: path.into(),
                    symbol: symbol.clone(),
                })),
                None => {
                    set.insert(Access::Path(path.into()));
                }
            }
        }
        Self(set)
    }

    pub fn insert(&mut self, access: Access) {
        self.0.insert(access);
    }

    pub fn extend(&mut self, other: &AccessSet) {
        self.0.extend(other.0.iter().cloned());
    }

    pub fn iter(&self) -> impl Iterator<Item = &Access> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Symbol entries on `files` become whole paths (unparsed or unknown files).
    pub fn coarsen(&self, files: &BTreeSet<String>) -> Self {
        Self(
            self.0
                .iter()
                .map(|a| match a {
                    Access::Symbol { path, .. } if files.contains(path) => a.coarse(),
                    _ => a.clone(),
                })
                .collect(),
        )
    }

    /// Entries of `self` that overlap some entry of `other`, spelled out and sorted.
    pub fn meeting(&self, other: &AccessSet) -> Vec<String> {
        let mut out: Vec<String> = self
            .0
            .iter()
            .filter(|a| other.0.iter().any(|b| a.overlaps(b)))
            .map(Access::to_string)
            .collect();
        out.sort();
        out
    }

    pub fn meets(&self, other: &AccessSet) -> bool {
        self.0.iter().any(|a| other.0.iter().any(|b| a.overlaps(b)))
    }

    /// Entries spelled out, sorted.
    pub fn entries(&self) -> Vec<String> {
        let mut out: Vec<String> = self.0.iter().map(Access::to_string).collect();
        out.sort();
        out
    }

    /// Symbol entries grouped by file.
    pub fn symbols_by_path(&self) -> BTreeMap<&str, Vec<&str>> {
        let mut out: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for access in &self.0 {
            if let Access::Symbol { path, symbol } = access {
                out.entry(path).or_default().push(symbol);
            }
        }
        out
    }
}

/// The paper's Eq. 1, both ways: neither change writes what the other reads or writes.
pub fn independent(
    reads_a: &AccessSet,
    writes_a: &AccessSet,
    reads_b: &AccessSet,
    writes_b: &AccessSet,
) -> bool {
    !writes_a.meets(reads_b)
        && !writes_a.meets(writes_b)
        && !writes_b.meets(reads_a)
        && !writes_b.meets(writes_a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_parse_symbols_only_when_the_suffix_is_a_symbol_path() {
        assert_eq!(
            Access::parse("src/lib.rs#Policy::backoff"),
            Access::Symbol {
                path: "src/lib.rs".into(),
                symbol: "Policy::backoff".into()
            }
        );
        assert_eq!(
            Access::parse("src/lib.rs#r#type"),
            Access::Symbol {
                path: "src/lib.rs".into(),
                symbol: "r#type".into()
            }
        );
        for path in ["notes#2.md", "src/", "a#b c", "#x", "dir/#x", "a#", "a#b::"] {
            assert_eq!(Access::parse(path), Access::Path(path.into()), "{path}");
        }
        assert_eq!(
            Access::parse("dir#1/a.ts#load").to_string(),
            "dir#1/a.ts#load"
        );
        assert_eq!(Access::parse("dir#1/a.ts#load").path(), "dir#1/a.ts");
    }

    #[test]
    fn symbols_overlap_their_members_and_paths_cover_symbols() {
        let read = |e: &str| AccessSet::parse([e]);
        let wrote = |e: &str| AccessSet::parse([e]);
        assert!(read("a.rs#Cache").meets(&wrote("a.rs#Cache::get")));
        assert!(read("a.rs#Cache::get").meets(&wrote("a.rs#Cache")));
        assert!(!read("a.rs#Cache::put").meets(&wrote("a.rs#Cache::get")));
        assert!(!read("a.rs#Cache2").meets(&wrote("a.rs#Cache")));
        assert!(!read("b.rs#Cache").meets(&wrote("a.rs#Cache")));
        assert!(read("a.rs").meets(&wrote("a.rs#x")));
        assert!(read("src/").meets(&wrote("src/a.rs#x")));
        assert!(read("a.rs#x").meets(&wrote("a.rs")));
        // A file literally named like a symbol entry is still that file.
        assert!(read("a#b").meets(&wrote("a#b")));
    }

    #[test]
    fn unresolved_writes_stay_whole_files() {
        let refined = vec![
            SymbolTouch {
                path: "a.rs".into(),
                symbols: vec!["f".into()],
            },
            SymbolTouch {
                path: "b.rs".into(),
                symbols: vec![],
            },
        ];
        let writes = AccessSet::writes(["a.rs", "b.rs", "c.rs"], &refined);
        assert_eq!(writes.entries(), ["a.rs#f", "b.rs", "c.rs"]);
        let coarse = AccessSet::parse(["a.rs#f", "x.rs#g"]).coarsen(&["a.rs".into()].into());
        assert_eq!(coarse.entries(), ["a.rs", "x.rs#g"]);
    }
}
