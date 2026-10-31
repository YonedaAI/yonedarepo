//! Where open Landings meet, for the radar: the same symbol, the same file, or one that read what
//! another wrote. Closest first, and each pair shows from both sides.
use super::{Footprint, Overlap};
use schemars::JsonSchema;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::txlog::symbols_overlap;

/// Other Landings named per Landing, closest first.
const OVERLAPS: usize = 5;
/// Paths and symbols named per overlap.
const NAMED: usize = 5;

/// Another Landing on the same work.
#[derive(Debug, Serialize, JsonSchema)]
pub struct RadarOverlap {
    pub landing: i64,
    pub overlap: Overlap,
    pub paths: Vec<String>,
    pub symbols: Vec<String>,
}

/// How one Landing meets another.
#[derive(Default)]
struct Pair {
    symbols: BTreeSet<String>,
    files: BTreeSet<String>,
    reads: BTreeSet<String>,
}

impl Pair {
    fn overlap(&self) -> Overlap {
        match (self.symbols.is_empty(), self.files.is_empty()) {
            (false, _) => Overlap::Symbol,
            (_, false) => Overlap::File,
            _ => Overlap::Read,
        }
    }

    fn shown(&self, landing: i64) -> RadarOverlap {
        let first = |set: &BTreeSet<String>| set.iter().take(NAMED).cloned().collect();
        RadarOverlap {
            landing,
            overlap: self.overlap(),
            paths: first(if self.files.is_empty() {
                &self.reads
            } else {
                &self.files
            }),
            symbols: first(&self.symbols),
        }
    }
}

type Pairs = BTreeMap<(i64, i64), Pair>;

/// Who writes each path.
fn writers(prints: &BTreeMap<i64, Footprint>) -> BTreeMap<&str, Vec<(i64, &BTreeSet<String>)>> {
    let mut by_path: BTreeMap<&str, Vec<(i64, &BTreeSet<String>)>> = BTreeMap::new();
    for (landing, print) in prints {
        for (path, symbols) in &print.writes {
            by_path.entry(path).or_default().push((*landing, symbols));
        }
    }
    by_path
}

fn same_writes(by_path: &BTreeMap<&str, Vec<(i64, &BTreeSet<String>)>>, pairs: &mut Pairs) {
    for (path, on) in by_path {
        for (a, symbols) in on {
            for (b, theirs) in on.iter().filter(|(b, _)| b != a) {
                let pair = pairs.entry((*a, *b)).or_default();
                pair.files.insert((*path).to_owned());
                let met = (symbols.iter())
                    .filter(|s| theirs.iter().any(|t| symbols_overlap(s, t)))
                    .cloned();
                pair.symbols.extend(met);
            }
        }
    }
}

/// A read meets the path itself, or everything under a `dir/`.
fn reads_met(
    prints: &BTreeMap<i64, Footprint>,
    by_path: &BTreeMap<&str, Vec<(i64, &BTreeSet<String>)>>,
    pairs: &mut Pairs,
) {
    for (reader, print) in prints {
        for read in &print.reads {
            let met = (by_path.range(read.as_str()..))
                .take_while(|(path, _)| path.starts_with(read.as_str()))
                .filter(|(path, _)| read.ends_with('/') || **path == read.as_str());
            for (path, on) in met {
                for (writer, _) in on.iter().filter(|(w, _)| w != reader) {
                    for key in [(*reader, *writer), (*writer, *reader)] {
                        pairs
                            .entry(key)
                            .or_default()
                            .reads
                            .insert((*path).to_owned());
                    }
                }
            }
        }
    }
}

/// Each Landing's overlaps, closest first and then newest.
pub(super) fn overlaps(prints: &BTreeMap<i64, Footprint>) -> BTreeMap<i64, Vec<RadarOverlap>> {
    let by_path = writers(prints);
    let mut pairs = Pairs::new();
    same_writes(&by_path, &mut pairs);
    reads_met(prints, &by_path, &mut pairs);
    let mut out: BTreeMap<i64, Vec<RadarOverlap>> = BTreeMap::new();
    for ((landing, other), pair) in &pairs {
        out.entry(*landing).or_default().push(pair.shown(*other));
    }
    for list in out.values_mut() {
        list.sort_by_key(|o| o.overlap);
        list.truncate(OVERLAPS);
    }
    out
}
