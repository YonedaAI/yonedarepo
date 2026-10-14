//! Git metadata-derived refresh scopes; no source bodies or agent path claims.
use crate::source_git_tree::TreeEntry;
use std::collections::{BTreeMap, BTreeSet};
use yoneda_core::Result;
pub(crate) type Files = BTreeMap<String, TreeEntry>;
pub(crate) struct Plan {
    pub captured: BTreeSet<String>,
    pub intervening: BTreeSet<String>,
    pub overlapping: BTreeSet<String>,
    pub union: BTreeSet<String>,
    pub structural: BTreeSet<String>,
}
pub(crate) fn derive(
    base: &Files,
    head: &Files,
    candidate: &Files,
    declared: &[String],
) -> Result<Plan> {
    let distinct = declared.iter().collect::<BTreeSet<_>>();
    if declared.is_empty() || declared.len() > 20000 || distinct.len() != declared.len() {
        return Err(error("Invalid owner-approved declared paths"));
    }
    for scope in declared {
        yoneda_core::validate_path(scope.strip_suffix('/').unwrap_or(scope))?;
    }
    let captured = changed(base, candidate);
    let intervening = changed(base, head);
    if captured.iter().any(|path| {
        !declared
            .iter()
            .any(|scope| path == scope || scope.ends_with('/') && path.starts_with(scope))
    }) {
        return Err(error("Captured paths exceed frozen owner-approved paths"));
    }
    let overlapping = captured.intersection(&intervening).cloned().collect();
    let union = captured.union(&intervening).cloned().collect();
    let structural = captured
        .iter()
        .filter(|p| {
            intervening
                .iter()
                .any(|q| p != &q && (ancestor(p, q) || ancestor(q, p)))
        })
        .cloned()
        .collect();
    Ok(Plan {
        captured,
        intervening,
        overlapping,
        union,
        structural,
    })
}
fn ancestor(parent: &str, child: &str) -> bool {
    child
        .strip_prefix(parent)
        .is_some_and(|suffix| suffix.starts_with('/'))
}
fn changed(before: &Files, after: &Files) -> BTreeSet<String> {
    before
        .keys()
        .chain(after.keys())
        .filter(|path| match (before.get(*path), after.get(*path)) {
            (Some(a), Some(b)) => a.mode != b.mode || a.oid != b.oid,
            (None, None) => false,
            _ => true,
        })
        .cloned()
        .collect()
}
pub(crate) fn error(message: &str) -> yoneda_core::Error {
    yoneda_core::Error::new("SOURCE_REFRESH", message)
}
