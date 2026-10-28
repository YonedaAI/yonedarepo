//! Golden ids come from real `git` (hash-object, mktree, commit-tree).
use super::*;
use std::{cell::RefCell, collections::HashMap};

const HELLO: &str = "ce013625030ba8dba906f756967f9e9ca394464a";
const SCRIPT: &str = "1a2485251c33a70432394c93fb89330ef214bfc9";
const SUB_TREE: &str = "66c31ab1b81cb3c5a77682b67611d2d6984ba73d";
const ROOT_TREE: &str = "17358b7c8806c41cd6e2fd717cac03703a8d242b";
const FIRST: &str = "9cc640ed68a9dfd89fbcc3275ba1ba846b31ecdb";
const SECOND: &str = "6e27d2210faacfe1f012b225e55c4811128306df";

fn id(hex: &str) -> ObjectId {
    ObjectId::parse(hex).unwrap()
}
fn file(name: &str, mode: FileMode, hex: &str) -> TreeEntry {
    TreeEntry {
        name: name.into(),
        mode,
        id: id(hex),
    }
}
fn root_entries() -> Vec<TreeEntry> {
    // Deliberately unsorted: "src" (a tree) must sort after "src.txt".
    vec![
        file("src", FileMode::Tree, SUB_TREE),
        file("run.sh", FileMode::Executable, SCRIPT),
        file("src.txt", FileMode::Blob, HELLO),
        file("a.txt", FileMode::Blob, HELLO),
    ]
}
fn sig(name: &str, email: &str, seconds: i64, offset: &str) -> Signature {
    Signature {
        name: name.into(),
        email: email.into(),
        seconds,
        offset: offset.parse().unwrap(),
    }
}

#[test]
fn object_ids_match_git() {
    assert_eq!(hash_object(ObjectKind::Blob, b"hello\n").hex(), HELLO);
    assert_eq!(
        hash_object(ObjectKind::Blob, b"").hex(),
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
    );
    assert_eq!(
        hash_object(ObjectKind::Tree, b"").hex(),
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    );
    let tree = encode_tree(&root_entries()).unwrap();
    assert_eq!(hash_object(ObjectKind::Tree, &tree).hex(), ROOT_TREE);
}

#[test]
fn ids_have_one_spelling_and_round_trip_through_json() {
    assert!(ObjectId::parse(&HELLO.to_uppercase()).is_err());
    assert!(ObjectId::parse(&HELLO[..39]).is_err());
    let json = serde_json::to_string(&id(HELLO)).unwrap();
    assert_eq!(json, format!("\"{HELLO}\""));
    assert_eq!(serde_json::from_str::<ObjectId>(&json).unwrap(), id(HELLO));
}

#[test]
fn trees_decode_losslessly_and_reject_unsafe_input() {
    let bytes = encode_tree(&root_entries()).unwrap();
    let decoded = decode_tree(&bytes).unwrap();
    assert_eq!(encode_tree(&decoded).unwrap(), bytes);
    assert!(encode_tree(&[file(".git", FileMode::Blob, HELLO)]).is_err());
    assert!(
        encode_tree(&[
            file("a", FileMode::Blob, HELLO),
            file("a", FileMode::Blob, SCRIPT)
        ])
        .is_err()
    );
    // Swap the first two records to break canonical order.
    let entries = decode_tree(&bytes).unwrap();
    let mut swapped = Vec::new();
    for e in [&entries[1], &entries[0]].into_iter().chain(&entries[2..]) {
        swapped.extend(encode_tree(std::slice::from_ref(e)).unwrap());
    }
    assert!(decode_tree(&swapped).is_err());
}

#[test]
fn commits_match_git_and_expose_trailers() {
    let ada = sig("Ada L", "ada@example.com", 1_700_000_000, "+0100");
    let first = Commit::new(id(ROOT_TREE), &[], &ada, &ada, "first").unwrap();
    assert_eq!(first.id().hex(), FIRST);
    let bo = sig("Bo", "bo@example.com", 1_700_000_100, "-0500");
    let second = Commit::new(
        id(ROOT_TREE),
        &[first.id()],
        &bo,
        &bo,
        "second\n\nYoneda-Intent: abc",
    )
    .unwrap();
    assert_eq!(second.id().hex(), SECOND);
    assert_eq!(second.parents().unwrap(), vec![id(FIRST)]);
    assert_eq!(second.author().unwrap(), bo);
    assert_eq!(
        second.trailers(),
        vec![("Yoneda-Intent".into(), "abc".into())]
    );
    assert!(first.trailers().is_empty());
    assert!(Commit::new(id(ROOT_TREE), &[], &sig("x<y", "e", 0, "+0000"), &ada, "m").is_err());
}

#[test]
fn commit_decoding_preserves_unknown_multiline_headers() {
    let raw = format!(
        "tree {ROOT_TREE}\nparent {FIRST}\nauthor Bo <bo@example.com> 1 +0000\n\
         committer Bo <bo@example.com> 1 +0000\ngpgsig -----BEGIN-----\n line two\n -----END-----\n\nsigned\n"
    );
    let commit = Commit::decode(raw.as_bytes()).unwrap();
    assert_eq!(commit.encode(), raw.as_bytes());
    assert_eq!(commit.message(), b"signed\n");
    assert!(Commit::decode(b"author Bo <b> 1 +0000\n\nno tree\n").is_err());
}

#[test]
fn packs_round_trip_and_reject_tampering() {
    let tree = encode_tree(&root_entries()).unwrap();
    let big = vec![b'x'; 70_000];
    let objects = [
        (ObjectKind::Blob, &b"hello\n"[..]),
        (ObjectKind::Tree, &tree[..]),
        (ObjectKind::Blob, &big[..]),
    ];
    let pack = write_pack(&objects).unwrap();
    let read = read_pack(&pack, PackLimits::default()).unwrap();
    assert_eq!(read.len(), 3);
    assert_eq!(read[2].1, big);
    assert_eq!(hash_object(read[1].0, &read[1].1).hex(), ROOT_TREE);
    let mut tampered = pack.clone();
    tampered[20] ^= 1;
    assert!(read_pack(&tampered, PackLimits::default()).is_err());
    let small = PackLimits {
        max_object_bytes: 1_000,
        ..PackLimits::default()
    };
    assert!(read_pack(&pack, small).is_err());
}

struct Trees {
    map: HashMap<ObjectId, Vec<TreeEntry>>,
    reads: RefCell<Vec<ObjectId>>,
}
impl Trees {
    fn new(trees: &[Vec<TreeEntry>]) -> Self {
        let map = trees
            .iter()
            .map(|t| {
                (
                    hash_object(ObjectKind::Tree, &encode_tree(t).unwrap()),
                    t.clone(),
                )
            })
            .collect();
        Self {
            map,
            reads: RefCell::default(),
        }
    }
}
impl TreeSource for Trees {
    fn tree(&self, id: &ObjectId) -> crate::Result<Vec<TreeEntry>> {
        self.reads.borrow_mut().push(*id);
        self.map
            .get(id)
            .cloned()
            .ok_or_else(|| invalid("missing tree"))
    }
}
fn set(path: &str, mode: FileMode, hex: &str) -> PathChange {
    PathChange {
        path: path.into(),
        target: Some((mode, id(hex))),
    }
}
fn delete(path: &str) -> PathChange {
    PathChange {
        path: path.into(),
        target: None,
    }
}

#[test]
fn rewriting_from_empty_reproduces_the_git_tree() {
    let changes = [
        set("src/inner.txt", FileMode::Blob, HELLO),
        set("a.txt", FileMode::Blob, HELLO),
        set("run.sh", FileMode::Executable, SCRIPT),
        set("src.txt", FileMode::Blob, HELLO),
    ];
    let rewrite = rewrite_tree(None, &changes, &Trees::new(&[])).unwrap();
    assert_eq!(rewrite.root.hex(), ROOT_TREE);
    assert_eq!(rewrite.trees.len(), 2);
}

#[test]
fn rewriting_reads_only_directories_on_changed_paths() {
    let untouched = vec![file("keep.txt", FileMode::Blob, HELLO)];
    let untouched_id = hash_object(ObjectKind::Tree, &encode_tree(&untouched).unwrap());
    let sub = vec![file("inner.txt", FileMode::Blob, HELLO)];
    let mut root = root_entries();
    root.push(file("vendor", FileMode::Tree, &untouched_id.hex()));
    let source = Trees::new(&[untouched, sub, root.clone()]);
    let base = hash_object(ObjectKind::Tree, &encode_tree(&root).unwrap());
    let changes = [
        set("src/inner.txt", FileMode::Executable, SCRIPT),
        delete("a.txt"),
    ];
    let rewrite = rewrite_tree(Some(base), &changes, &source).unwrap();
    assert!(
        !source.reads.borrow().contains(&untouched_id),
        "vendor/ must not be read"
    );
    let new_root = decode_tree(
        &rewrite
            .trees
            .iter()
            .find(|(i, _)| *i == rewrite.root)
            .unwrap()
            .1,
    )
    .unwrap();
    assert!(new_root.iter().all(|e| e.name != "a.txt"));
    assert!(
        new_root
            .iter()
            .any(|e| e.name == "vendor" && e.id == untouched_id)
    );
    // Deleting the last file prunes its now-empty directory.
    let pruned = rewrite_tree(Some(base), &[delete("src/inner.txt")], &source).unwrap();
    let pruned_root = decode_tree(
        &pruned
            .trees
            .iter()
            .find(|(i, _)| *i == pruned.root)
            .unwrap()
            .1,
    )
    .unwrap();
    assert!(pruned_root.iter().all(|e| e.name != "src"));
}

#[test]
fn rewriting_rejects_ambiguous_changes() {
    let source = Trees::new(&[
        root_entries(),
        vec![file("inner.txt", FileMode::Blob, HELLO)],
    ]);
    let base = Some(id(ROOT_TREE));
    for bad in [
        vec![delete("missing.txt")],
        vec![set("a.txt/child", FileMode::Blob, HELLO)],
        vec![set("src", FileMode::Blob, HELLO)],
        vec![
            set("x", FileMode::Blob, HELLO),
            set("x", FileMode::Blob, SCRIPT),
        ],
        vec![set("../escape", FileMode::Blob, HELLO)],
        vec![set("dir", FileMode::Tree, SUB_TREE)],
    ] {
        assert!(rewrite_tree(base, &bad, &source).is_err(), "{bad:?}");
    }
    // A file may become a directory when it is deleted in the same change.
    let ok = [delete("a.txt"), set("a.txt/child", FileMode::Blob, HELLO)];
    assert!(rewrite_tree(base, &ok, &source).is_ok());
}

struct Dag(HashMap<ObjectId, (Vec<ObjectId>, u64)>);
impl Dag {
    /// `edges` lists (commit, parents) in topological order; ids are small integers.
    fn new(edges: &[(u8, &[u8])]) -> Self {
        let mut map: HashMap<ObjectId, (Vec<ObjectId>, u64)> = HashMap::new();
        for (commit, parents) in edges {
            let parents: Vec<ObjectId> = parents
                .iter()
                .map(|p| ObjectId::from_bytes([*p; 20]))
                .collect();
            let generation = next_generation(&parents.iter().map(|p| map[p].1).collect::<Vec<_>>());
            map.insert(ObjectId::from_bytes([*commit; 20]), (parents, generation));
        }
        Self(map)
    }
}
impl CommitGraph for Dag {
    fn parents(&self, id: &ObjectId) -> crate::Result<Vec<ObjectId>> {
        Ok(self.0[id].0.clone())
    }
    fn generation(&self, id: &ObjectId) -> crate::Result<u64> {
        Ok(self.0[id].1)
    }
}
fn n(x: u8) -> ObjectId {
    ObjectId::from_bytes([x; 20])
}

#[test]
fn merge_base_and_ancestry_follow_the_dag() {
    // 1 ← 2 ← 3 (left);  2 ← 4 ← 5 (right);  6 merges 3 and 5.
    let dag = Dag::new(&[
        (1, &[]),
        (2, &[1]),
        (3, &[2]),
        (4, &[2]),
        (5, &[4]),
        (6, &[3, 5]),
    ]);
    assert_eq!(merge_bases(&dag, &n(3), &n(5)).unwrap(), vec![n(2)]);
    assert_eq!(merge_bases(&dag, &n(6), &n(5)).unwrap(), vec![n(5)]);
    assert!(is_ancestor(&dag, &n(1), &n(6)).unwrap());
    assert!(is_ancestor(&dag, &n(4), &n(6)).unwrap());
    assert!(!is_ancestor(&dag, &n(3), &n(5)).unwrap());
}

#[test]
fn criss_cross_merges_report_every_best_base() {
    // 1 ← 2, 1 ← 3; 4 = merge(2,3); 5 = merge(3,2); bases of 4 and 5 are {2, 3}.
    let dag = Dag::new(&[(1, &[]), (2, &[1]), (3, &[1]), (4, &[2, 3]), (5, &[3, 2])]);
    let mut bases = merge_bases(&dag, &n(4), &n(5)).unwrap();
    bases.sort();
    assert_eq!(bases, vec![n(2), n(3)]);
}

#[test]
fn receive_pack_framing_matches_git_and_rejects_partial_reports() {
    let commit = id(FIRST);
    let refname = hidden_ref(&commit);
    let body = receive_pack_request(&refname, None, commit, b"PACK").unwrap();
    let line = format!("{} {FIRST} {refname}\0report-status\n", "0".repeat(40));
    assert_eq!(
        body,
        format!("{:04x}{line}0000PACK", line.len() + 4).into_bytes()
    );
    assert!(receive_pack_request("main", None, commit, b"").is_err());
    let ok = format!("000eunpack ok\n{:04x}ok {refname}\n0000", refname.len() + 8);
    verify_receive_pack_report(ok.as_bytes(), &refname).unwrap();
    let rejected = format!(
        "000eunpack ok\n{:04x}ng {refname} denied\n0000",
        refname.len() + 15
    );
    assert!(verify_receive_pack_report(rejected.as_bytes(), &refname).is_err());
    assert!(verify_receive_pack_report(b"0000", &refname).is_err());
}
