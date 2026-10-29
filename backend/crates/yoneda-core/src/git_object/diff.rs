//! Tree-to-tree diff that descends only into subtrees whose ids differ, so its cost
//! follows the size of the change. Trees come from a caller-supplied map or source; when
//! some are missing the walk reports exactly which ids it needs next instead of failing.
use super::{FileMode, ObjectId, TreeEntry};
use crate::{Error, Result};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A file-level difference. Directories never appear; their contents do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeChange {
    pub path: String,
    pub old: Option<(FileMode, ObjectId)>,
    pub new: Option<(FileMode, ObjectId)>,
}

/// Either the finished result, or the trees the caller must supply before retrying.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Walk<T> {
    Need(BTreeSet<ObjectId>),
    Done(T),
}

/// Where a walk reads trees: by id, or `None` when the tree is not held there (the walk
/// then names it as needed). A source may decode on demand, so a lookup can fail.
pub trait TreeLookup {
    fn entries(&mut self, id: &ObjectId) -> Result<Option<Cow<'_, [TreeEntry]>>>;
}

impl TreeLookup for &HashMap<ObjectId, Vec<TreeEntry>> {
    fn entries(&mut self, id: &ObjectId) -> Result<Option<Cow<'_, [TreeEntry]>>> {
        Ok(self.get(id).map(|list| Cow::Borrowed(list.as_slice())))
    }
}

type Side = Option<(FileMode, ObjectId)>;

fn entries(
    id: Option<ObjectId>,
    trees: &mut impl TreeLookup,
    need: &mut BTreeSet<ObjectId>,
) -> Result<Option<BTreeMap<String, (FileMode, ObjectId)>>> {
    let Some(id) = id else {
        return Ok(Some(BTreeMap::new()));
    };
    Ok(match trees.entries(&id)? {
        Some(list) => Some(
            list.iter()
                .map(|e| (e.name.clone(), (e.mode, e.id)))
                .collect(),
        ),
        None => {
            need.insert(id);
            None
        }
    })
}

/// Differences from `old` to `new` (either may be absent: an empty tree), sorted by path.
/// Fails with `TOO_LARGE` beyond `limit` changes.
pub fn diff_trees(
    old: Option<ObjectId>,
    new: Option<ObjectId>,
    trees: &HashMap<ObjectId, Vec<TreeEntry>>,
    limit: usize,
) -> Result<Walk<Vec<TreeChange>>> {
    diff_trees_in(old, new, &mut { trees }, limit)
}

/// `diff_trees` reading trees from `trees` as the walk reaches them.
pub fn diff_trees_in(
    old: Option<ObjectId>,
    new: Option<ObjectId>,
    trees: &mut impl TreeLookup,
    limit: usize,
) -> Result<Walk<Vec<TreeChange>>> {
    let mut changes = Vec::new();
    let mut need = BTreeSet::new();
    let mut stack = vec![(String::new(), old, new)];
    while let Some((prefix, old, new)) = stack.pop() {
        if old == new {
            continue;
        }
        let (Some(before), Some(after)) = (
            entries(old, trees, &mut need)?,
            entries(new, trees, &mut need)?,
        ) else {
            continue;
        };
        let names: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
        for name in names {
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let (a, b): (Side, Side) = (before.get(name).copied(), after.get(name).copied());
            if a == b {
                continue;
            }
            let tree_of = |s: Side| s.filter(|(m, _)| m.is_tree()).map(|(_, id)| id);
            let file_of = |s: Side| s.filter(|(m, _)| !m.is_tree());
            if tree_of(a).is_some() || tree_of(b).is_some() {
                stack.push((path.clone(), tree_of(a), tree_of(b)));
            }
            if file_of(a).is_some() || file_of(b).is_some() {
                changes.push(TreeChange {
                    path,
                    old: file_of(a),
                    new: file_of(b),
                });
                if changes.len() > limit {
                    return Err(Error::new(
                        "TOO_LARGE",
                        format!("Diff exceeds {limit} changed files"),
                    ));
                }
            }
        }
    }
    if !need.is_empty() {
        return Ok(Walk::Need(need));
    }
    changes.sort_by(|x, y| x.path.cmp(&y.path));
    Ok(Walk::Done(changes))
}
