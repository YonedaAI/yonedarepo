//! Which trees and blobs a fetch brings (`Filter`), walked down from commits' root trees
//! level by level (one request per level, shared subtrees fetched once), and the objects
//! a lazy clone's Git asks for by id.
//!
//! A lazy clone is a Git partial clone whose promisor remote is the platform: every pack
//! written here is marked as the promisor's, so Git accepts what it leaves out and fetches
//! it on first use through the helper. With a sparse scope (Git's cone mode) only the trees
//! on the way to and inside the scope's directories are brought; Git's sparse index never
//! reads the others.
use super::{PACK_BYTES, Ref, fetch, refs, verified, write};
use crate::api::Api;
use crate::error::{Error, Result};
use crate::git::Git;
use std::collections::{HashMap, HashSet};
use yoneda_core::git_object::{ObjectKind, decode_tree};

/// What a fetch brings into the local repository.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Filter {
    /// Every tree and blob.
    #[default]
    Full,
    /// Commits and trees; of the trees only those leading to or inside one of `scope`'s
    /// directories (every tree when it is empty). Blobs come when Git needs them.
    Lazy { scope: Vec<String> },
}

impl Filter {
    pub fn lazy(&self) -> bool {
        matches!(self, Self::Lazy { .. })
    }

    fn scope(&self) -> &[String] {
        match self {
            Self::Full => &[],
            Self::Lazy { scope } => scope,
        }
    }

    /// Whether the object of `kind` at `path` is brought.
    fn wants(&self, kind: ObjectKind, path: &str) -> bool {
        match self {
            Self::Full => true,
            Self::Lazy { scope } => kind == ObjectKind::Tree && in_scope(scope, path),
        }
    }
}

/// Whether the directory `path` ("" for the root) leads to or lies within one of `scope`'s.
fn in_scope(scope: &[String], path: &str) -> bool {
    path.is_empty()
        || scope.is_empty()
        || scope.iter().any(|dir| {
            dir == path
                || dir.strip_prefix(path).is_some_and(|r| r.starts_with('/'))
                || path
                    .strip_prefix(dir.as_str())
                    .is_some_and(|r| r.starts_with('/'))
        })
}

/// Sparse scope directories as repository paths (`a/b`), refusing anything else.
pub fn normalize_scope(paths: &[String]) -> Result<Vec<String>> {
    let mut dirs: Vec<String> = Vec::new();
    for path in paths {
        let dir = path.trim().trim_matches('/');
        let valid = !dir.is_empty()
            && dir
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..");
        if !valid {
            return Err(Error::usage(format!(
                "{path:?} is not a directory path in the repository (like src/app)"
            )));
        }
        if !dirs.iter().any(|d| d == dir) {
            dirs.push(dir.to_owned());
        }
    }
    Ok(dirs)
}

/// One object to visit: its id and kind, and its path ("" for a root tree).
struct Visit {
    id: String,
    kind: ObjectKind,
    path: String,
}

fn joined(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// Fetches what `filter` wants under any of `roots` that the local repository lacks, as one
/// walk written as one pack per 64 MiB. A tree held already is taken as complete, except
/// within a sparse scope: there it is read locally, since the scope may have grown since
/// it was fetched.
pub async fn fetch_trees(api: &Api, git: &Git, roots: &[String], filter: &Filter) -> Result<()> {
    let scoped = !filter.scope().is_empty();
    // A scoped walk visits a tree once per path (its subtrees' fate depends on the path).
    let key = |id: &str, path: &str| (id.to_owned(), if scoped { path } else { "" }.to_owned());
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut level: Vec<Visit> = roots
        .iter()
        .filter(|root| seen.insert(key(root, "")))
        .map(|root| Visit {
            id: root.clone(),
            kind: ObjectKind::Tree,
            path: String::new(),
        })
        .collect();
    let mut pending: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
    let mut pending_bytes = 0usize;
    while !level.is_empty() {
        // Each id once, in the order the trees name them.
        let mut kinds: HashMap<&str, ObjectKind> = HashMap::new();
        let mut ids: Vec<String> = Vec::new();
        for visit in &level {
            if kinds.insert(&visit.id, visit.kind).is_none() {
                ids.push(visit.id.clone());
            }
        }
        let absent: HashSet<String> = git.missing(&ids)?.into_iter().collect();
        let wanted: Vec<(String, ObjectKind)> = ids
            .iter()
            .filter(|id| absent.contains(*id))
            .map(|id| (id.clone(), kinds[id.as_str()]))
            .collect();
        let mut below: HashMap<String, Vec<Ref>> = HashMap::new();
        for object in fetch(api, &wanted).await? {
            let (kind, data, refs) = verified(&object)?;
            if kind == ObjectKind::Tree {
                below.insert(object["id"].as_str().unwrap_or_default().to_owned(), refs);
            }
            pending_bytes += data.len();
            pending.push((kind, data));
        }
        if scoped {
            let held: Vec<String> = ids
                .iter()
                .filter(|id| !absent.contains(*id) && kinds[id.as_str()] == ObjectKind::Tree)
                .cloned()
                .collect();
            for (id, (kind, data)) in git.read_objects(&held)? {
                if kind == ObjectKind::Tree {
                    let entries = decode_tree(&data)
                        .map_err(|e| Error::new(format!("local tree {id}: {}", e.message)))?;
                    below.insert(id, refs(&entries));
                }
            }
        }
        if pending_bytes > PACK_BYTES {
            write(git, &mut pending, filter)?;
            pending_bytes = 0;
        }
        let mut next = Vec::new();
        for visit in &level {
            for (id, kind, name) in below.get(&visit.id).into_iter().flatten() {
                let path = joined(&visit.path, name);
                if filter.wants(*kind, &path) && seen.insert(key(id, &path)) {
                    next.push(Visit {
                        id: id.clone(),
                        kind: *kind,
                        path,
                    });
                }
            }
        }
        level = next;
    }
    write(git, &mut pending, filter)
}

/// Objects Git asked for by id (a lazy clone's fetch on first use), each brought alone:
/// asked as blobs, then what the platform has no blob for as trees. Returns the ids it
/// has as neither (commits, which come with their history, are the caller's).
pub async fn fetch_by_id(
    api: &Api,
    git: &Git,
    ids: &[String],
    filter: &Filter,
) -> Result<Vec<String>> {
    let mut rest = ids.to_vec();
    for kind in [ObjectKind::Blob, ObjectKind::Tree] {
        if rest.is_empty() {
            break;
        }
        let wanted: Vec<(String, ObjectKind)> = rest.iter().map(|id| (id.clone(), kind)).collect();
        let (served, missing) = super::transfer::request(api, &wanted, false).await?;
        let mut objects = served
            .iter()
            .map(|object| verified(object).map(|(kind, data, _)| (kind, data)))
            .collect::<Result<Vec<_>>>()?;
        write(git, &mut objects, filter)?;
        rest = missing;
    }
    Ok(rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs(list: &[&str]) -> Vec<String> {
        list.iter().map(|d| (*d).to_owned()).collect()
    }

    #[test]
    fn a_scope_holds_the_way_to_its_directories_and_everything_inside() {
        let scope = dirs(&["src/app", "docs"]);
        for path in ["", "src", "src/app", "src/app/deep/er", "docs", "docs/x"] {
            assert!(in_scope(&scope, path), "{path}");
        }
        for path in ["lib", "src/application", "src/other", "doc", "docsx/a"] {
            assert!(!in_scope(&scope, path), "{path}");
        }
        assert!(in_scope(&[], "anything/at/all"));
        let lazy = Filter::Lazy { scope };
        assert!(lazy.wants(ObjectKind::Tree, "src"));
        assert!(!lazy.wants(ObjectKind::Blob, "src/app/main.rs"));
        assert!(Filter::Full.wants(ObjectKind::Blob, "lib/x"));
    }

    #[test]
    fn scope_paths_are_plain_directories() -> Result<()> {
        let given = dirs(&["/src/app/", "docs", "docs/"]);
        assert_eq!(normalize_scope(&given)?, dirs(&["src/app", "docs"]));
        for bad in ["", "/", "a/../b", "./a", "a//b"] {
            assert!(normalize_scope(&dirs(&[bad])).is_err(), "{bad}");
        }
        Ok(())
    }
}
