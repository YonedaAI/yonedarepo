//! Tree-level merge corpus: disjoint paths, content merges, modify/delete, add/add,
//! rename/delete, mode changes and directory/file clashes.
use crate::git_object::*;
use crate::merge::{PathConflictKind, TreeMerge, merge_trees};
use std::collections::HashMap;

#[derive(Default)]
struct Store(HashMap<ObjectId, Vec<TreeEntry>>);
impl TreeSource for Store {
    fn tree(&self, id: &ObjectId) -> crate::Result<Vec<TreeEntry>> {
        self.0
            .get(id)
            .cloned()
            .ok_or_else(|| crate::Error::new("T", "missing"))
    }
}

fn blob(text: &str) -> ObjectId {
    hash_object(ObjectKind::Blob, text.as_bytes())
}

impl Store {
    fn build(&mut self, files: &[(&str, FileMode, &str)]) -> ObjectId {
        let changes: Vec<PathChange> = files
            .iter()
            .map(|(p, m, t)| PathChange {
                path: (*p).into(),
                target: Some((*m, blob(t))),
            })
            .collect();
        let rewrite = rewrite_tree(None, &changes, &Store::default()).unwrap();
        for (id, bytes) in &rewrite.trees {
            self.0.insert(*id, decode_tree(bytes).unwrap());
        }
        rewrite.root
    }
    fn merge(
        &mut self,
        base: &[(&str, FileMode, &str)],
        ours: &[(&str, FileMode, &str)],
        theirs: &[(&str, FileMode, &str)],
    ) -> TreeMerge {
        let (b, o, t) = (self.build(base), self.build(ours), self.build(theirs));
        match merge_trees(Some(b), Some(o), Some(t), &self.0, 1000).unwrap() {
            Walk::Done(merge) => merge,
            Walk::Need(_) => panic!("all trees were built"),
        }
    }
}

const F: FileMode = FileMode::Blob;
const X: FileMode = FileMode::Executable;

#[test]
fn disjoint_paths_take_theirs() {
    let mut s = Store::default();
    let m = s.merge(
        &[("a", F, "a"), ("d/b", F, "b")],
        &[("a", F, "A"), ("d/b", F, "b")],
        &[("a", F, "a"), ("d/b", F, "B"), ("d/c", F, "c")],
    );
    assert_eq!(
        m.take,
        vec![
            ("d/b".into(), Some((F, blob("B")))),
            ("d/c".into(), Some((F, blob("c"))))
        ]
    );
    assert!(m.content.is_empty() && m.conflicts.is_empty());
}

#[test]
fn same_file_needs_a_content_merge_and_identical_changes_do_not() {
    let mut s = Store::default();
    let m = s.merge(&[("a", F, "a")], &[("a", F, "ours")], &[("a", F, "theirs")]);
    assert_eq!(m.content.len(), 1);
    assert_eq!(
        (m.content[0].ours, m.content[0].theirs, m.content[0].base),
        (blob("ours"), blob("theirs"), Some(blob("a")))
    );
    let same = s.merge(&[("a", F, "a")], &[("a", F, "x")], &[("a", F, "x")]);
    assert_eq!(same, TreeMerge::default());
}

#[test]
fn delete_and_add_conflicts() {
    let mut s = Store::default();
    let m = s.merge(
        &[("a", F, "a"), ("k", F, "k")],
        &[("a", F, "edited"), ("k", F, "k")],
        &[("k", F, "k")],
    );
    assert_eq!(
        m.conflicts,
        vec![("a".into(), PathConflictKind::ModifyDelete)]
    );
    let m = s.merge(
        &[("k", F, "k")],
        &[("k", F, "k"), ("n", F, "one")],
        &[("k", F, "k"), ("n", F, "two")],
    );
    assert_eq!(m.conflicts, vec![("n".into(), PathConflictKind::AddAdd)]);
    // Rename on one side (delete + add) against an edit of the old path.
    let m = s.merge(&[("old", F, "x")], &[("old", F, "x2")], &[("new", F, "x")]);
    assert_eq!(
        m.conflicts,
        vec![("old".into(), PathConflictKind::ModifyDelete)]
    );
    assert_eq!(m.take, vec![("new".into(), Some((F, blob("x"))))]);
}

#[test]
fn mode_changes_combine_with_content_changes() {
    let mut s = Store::default();
    let m = s.merge(
        &[("run", F, "v1")],
        &[("run", X, "v1")],
        &[("run", F, "v2")],
    );
    assert_eq!(m.content.len(), 0);
    assert_eq!(m.take, vec![("run".into(), Some((X, blob("v2"))))]);
    let m = s.merge(
        &[("run", F, "v1")],
        &[("run", X, "v2")],
        &[("run", F, "v3")],
    );
    assert_eq!(m.content[0].mode, X);
    let m = s.merge(
        &[("l", F, "t")],
        &[("l", FileMode::Symlink, "t1")],
        &[("l", X, "t")],
    );
    assert_eq!(m.conflicts, vec![("l".into(), PathConflictKind::Mode)]);
}

#[test]
fn directory_file_clash_conflicts() {
    let mut s = Store::default();
    let m = s.merge(
        &[("k", F, "k")],
        &[("k", F, "k"), ("p", F, "file")],
        &[("k", F, "k"), ("p/q", F, "nested")],
    );
    assert_eq!(
        m.conflicts,
        vec![("p/q".into(), PathConflictKind::DirectoryFile)]
    );
}
