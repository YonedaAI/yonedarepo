//! A tree-heavy push (many directories rewritten by many commits, like a monorepo's history)
//! is received, verified and handed out whole, with bounded memory: its commits and trees
//! inflate past what the receive path keeps in memory (16 MiB), and the push is accepted
//! all the same. Peak heap is counted by this test binary's allocator.
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use yoneda_core::git_object::{
    FileMode, ObjectId, ObjectKind, PackWriter, TreeEntry, encode_tree, hash_object,
};
use yoneda_platform::platform_git_receive::ReceiveSession;

struct Counting;
static HELD: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let held = HELD.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        PEAK.fetch_max(held, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        HELD.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const MIB: usize = 1024 * 1024;
const DIRS: usize = 1500;
const COMMITS: usize = 400;

struct Push {
    tip: ObjectId,
    pack: Vec<u8>,
    tree_bytes: usize,
}

/// One root commit of `DIRS` directories of one file each, then `COMMITS` commits each
/// rewriting one directory's file: every commit carries a new root tree of `DIRS` entries.
fn tree_heavy() -> Push {
    let mut objects: Vec<(ObjectKind, Vec<u8>)> = Vec::new();
    let mut tree_bytes = 0;
    let add = |objects: &mut Vec<(ObjectKind, Vec<u8>)>, kind, data: Vec<u8>| {
        let id = hash_object(kind, &data);
        objects.push((kind, data));
        id
    };
    let dir = |objects: &mut Vec<_>, d: usize, version: usize| {
        let blob = add(
            objects,
            ObjectKind::Blob,
            format!("dir {d} v{version}\n").into_bytes(),
        );
        let entry = TreeEntry {
            name: "f.txt".into(),
            mode: FileMode::Blob,
            id: blob,
        };
        add(objects, ObjectKind::Tree, encode_tree(&[entry]).unwrap())
    };
    let mut dirs: Vec<ObjectId> = (0..DIRS).map(|d| dir(&mut objects, d, 0)).collect();
    let mut parent: Option<ObjectId> = None;
    for c in 0..=COMMITS {
        if c > 0 {
            let d = (c * 7) % DIRS;
            dirs[d] = dir(&mut objects, d, c);
        }
        let entries: Vec<TreeEntry> = dirs
            .iter()
            .enumerate()
            .map(|(d, id)| TreeEntry {
                name: format!("d{d:04}"),
                mode: FileMode::Tree,
                id: *id,
            })
            .collect();
        let root = encode_tree(&entries).unwrap();
        tree_bytes += root.len();
        let root = add(&mut objects, ObjectKind::Tree, root);
        let who = format!("Tester <t@example.com> {} +0000", 1_700_000_000 + c);
        let parents = parent.map(|p| format!("parent {p}\n")).unwrap_or_default();
        let commit = format!("tree {root}\n{parents}author {who}\ncommitter {who}\n\nc{c}\n");
        parent = Some(add(&mut objects, ObjectKind::Commit, commit.into_bytes()));
    }
    let (mut writer, mut pack) = PackWriter::new(objects.len() as u32);
    for (kind, data) in &objects {
        pack.extend(writer.entry(*kind, data));
    }
    pack.extend_from_slice(&writer.finish());
    Push {
        tip: parent.unwrap(),
        pack,
        tree_bytes,
    }
}

fn pkt(line: &str) -> Vec<u8> {
    format!("{:04x}{line}", line.len() + 4).into_bytes()
}

#[test]
fn accepts_a_tree_heavy_push_with_bounded_memory() {
    let push = tree_heavy();
    assert!(
        push.tree_bytes > 16 * MIB,
        "the push's trees must outgrow 16 MiB"
    );
    let zero = "0".repeat(40);
    let mut body = pkt(&format!(
        "{zero} {} refs/heads/main\0report-status\n",
        push.tip
    ));
    body.extend_from_slice(b"0000");
    body.extend_from_slice(&push.pack);
    let pack_bytes = push.pack.len();
    drop(push.pack);

    let base = HELD.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let mut session = ReceiveSession::new();
    for chunk in body.chunks(64 * 1024) {
        session.feed(chunk).expect("feed");
    }
    drop(body);
    session.finish().expect("finish");
    // A root push carries everything it names: nothing outside the pack is asked for.
    let summary = session
        .verify(&json!({ "tips": [push.tip] }))
        .expect("verify");
    assert!(summary.get("need").is_none(), "asked for {summary}");
    assert_eq!(summary["verified"], COMMITS + 1);
    let page = session.verified_page(0, 10).expect("page");
    assert_eq!(page["commits"].as_array().map(Vec::len), Some(10));
    let (mut objects, mut trees) = (0, 0);
    loop {
        let out = session.next_objects(4 * MIB).expect("objects");
        if out.is_empty() {
            break;
        }
        let mut at = 0;
        while at < out.len() {
            let len = u32::from_be_bytes(out[at + 21..at + 25].try_into().unwrap()) as usize;
            let (kind, id) = (out[at], &out[at + 1..at + 21]);
            let data = &out[at + 25..at + 25 + len];
            let kind = match kind {
                1 => ObjectKind::Commit,
                2 => ObjectKind::Tree,
                _ => ObjectKind::Blob,
            };
            assert_eq!(hash_object(kind, data).as_bytes(), id);
            trees += usize::from(kind == ObjectKind::Tree);
            objects += 1;
            at += 25 + len;
        }
    }
    // Every root tree, the first commit's directories and one per later commit.
    assert_eq!(trees, (COMMITS + 1) + DIRS + COMMITS);
    assert_eq!(objects, summary["objects"].as_u64().unwrap() as usize);
    let peak = PEAK.load(Ordering::Relaxed) - base;
    println!(
        "tree-heavy push: {} MiB of trees, pack {} MiB, peak heap {} MiB",
        push.tree_bytes / MIB,
        pack_bytes / MIB,
        peak / MIB
    );
    // The pack itself is held (it is re-read on demand); what is kept besides it is bounded.
    assert!(peak < pack_bytes + 40 * MIB, "peak heap {} MiB", peak / MIB);
}
