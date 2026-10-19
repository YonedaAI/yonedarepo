//! Properties behind S3 (commit cost scales with the change): an incremental rewrite of a
//! base tree must equal building the final file set from scratch, for any edit sequence.
use super::*;
use proptest::prelude::*;
use std::collections::{BTreeMap, HashMap};

#[derive(Default)]
struct Store(HashMap<ObjectId, Vec<TreeEntry>>);
impl TreeSource for Store {
    fn tree(&self, id: &ObjectId) -> crate::Result<Vec<TreeEntry>> {
        self.0.get(id).cloned().ok_or_else(|| invalid("missing"))
    }
}
impl Store {
    fn keep(&mut self, rewrite: &Rewrite) {
        for (id, bytes) in &rewrite.trees {
            self.0.insert(*id, decode_tree(bytes).unwrap());
        }
    }
}

fn path() -> impl Strategy<Value = String> {
    // Few, short names force shared directories and file/dir name collisions like "a" vs "a.b".
    prop::collection::vec(prop::sample::select(vec!["a", "b", "a.b", "c-d"]), 1..4)
        .prop_map(|p| p.join("/"))
}

/// Drops paths that would make another path's prefix a file (not representable in Git).
fn representable(files: BTreeMap<String, u8>) -> BTreeMap<String, u8> {
    let mut out: BTreeMap<String, u8> = BTreeMap::new();
    for (p, v) in files {
        let clash = out
            .keys()
            .any(|q| p.starts_with(&format!("{q}/")) || q.starts_with(&format!("{p}/")));
        if !clash {
            out.insert(p, v);
        }
    }
    out
}

fn blob(v: u8) -> ObjectId {
    hash_object(ObjectKind::Blob, &[v])
}

fn scratch(files: &BTreeMap<String, u8>) -> ObjectId {
    let changes: Vec<_> = files
        .iter()
        .map(|(p, v)| PathChange {
            path: p.clone(),
            target: Some((FileMode::Blob, blob(*v))),
        })
        .collect();
    rewrite_tree(None, &changes, &Store::default())
        .unwrap()
        .root
}

proptest! {
    #[test]
    fn incremental_rewrite_equals_from_scratch(
        base in prop::collection::btree_map(path(), any::<u8>(), 1..12),
        edits in prop::collection::btree_map(path(), prop::option::of(any::<u8>()), 1..8),
    ) {
        let base = representable(base);
        let mut store = Store::default();
        let first = rewrite_tree(None, &base.iter().map(|(p, v)| PathChange { path: p.clone(), target: Some((FileMode::Blob, blob(*v))) }).collect::<Vec<_>>(), &store).unwrap();
        store.keep(&first);
        // Apply only edits that keep the file set representable; deletes only of existing files.
        let mut expected = base.clone();
        let mut changes = Vec::new();
        for (p, v) in edits {
            match v {
                None if expected.contains_key(&p) => { expected.remove(&p); changes.push(PathChange { path: p, target: None }); }
                Some(v) if !expected.keys().any(|q| q.starts_with(&format!("{p}/")) || p.starts_with(&format!("{q}/"))) => {
                    expected.insert(p.clone(), v);
                    changes.push(PathChange { path: p, target: Some((FileMode::Blob, blob(v))) });
                }
                _ => {}
            }
        }
        prop_assume!(!changes.is_empty());
        let incremental = rewrite_tree(Some(first.root), &changes, &store).unwrap();
        let empty = hash_object(ObjectKind::Tree, b"");
        let expected_root = if expected.is_empty() { empty } else { scratch(&expected) };
        prop_assert_eq!(incremental.root, expected_root);
    }

    #[test]
    fn trees_round_trip(files in prop::collection::btree_map("[a-z0-9._-]{1,12}", (any::<u8>(), any::<bool>()), 0..40)) {
        let entries: Vec<TreeEntry> = files.into_iter()
            .filter(|(n, _)| n != "." && n != ".." && !n.eq_ignore_ascii_case(".git"))
            .map(|(name, (v, dir))| TreeEntry { name, mode: if dir { FileMode::Tree } else { FileMode::Blob }, id: blob(v) })
            .collect();
        let bytes = encode_tree(&entries).unwrap();
        prop_assert_eq!(encode_tree(&decode_tree(&bytes).unwrap()).unwrap(), bytes);
    }

    #[test]
    fn packs_round_trip(objects in prop::collection::vec(prop::collection::vec(any::<u8>(), 0..3000), 0..12)) {
        let input: Vec<(ObjectKind, &[u8])> = objects.iter().map(|o| (ObjectKind::Blob, o.as_slice())).collect();
        let read = read_pack(&write_pack(&input).unwrap(), PackLimits::default()).unwrap();
        prop_assert_eq!(read.into_iter().map(|(_, d)| d).collect::<Vec<_>>(), objects);
    }
}
