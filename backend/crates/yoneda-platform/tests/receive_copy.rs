//! A pack copied whole into the store of record (a retired mirror's history): every commit,
//! tree and blob comes out framed, commits first, except the blobs it is told to skip
//! (withheld ones). Nothing is verified against a repository: the history is already the
//! repository's.
use serde_json::json;
use yoneda_core::git_object::{
    FileMode, ObjectId, ObjectKind, PackWriter, TreeEntry, encode_tree, hash_object,
};
use yoneda_platform::platform_git_receive::ReceiveSession;

fn pkt(line: &str) -> Vec<u8> {
    format!("{:04x}{line}", line.len() + 4).into_bytes()
}

/// Frames as `next_objects` hands them out: (kind byte, id).
fn frames(session: &mut ReceiveSession) -> Vec<(u8, ObjectId)> {
    let mut out = Vec::new();
    loop {
        let batch = session.next_objects(1024).expect("objects");
        if batch.is_empty() {
            return out;
        }
        let mut at = 0;
        while at < batch.len() {
            let len = u32::from_be_bytes(batch[at + 21..at + 25].try_into().unwrap()) as usize;
            let kind = match batch[at] {
                1 => ObjectKind::Commit,
                2 => ObjectKind::Tree,
                _ => ObjectKind::Blob,
            };
            let id = hash_object(kind, &batch[at + 25..at + 25 + len]);
            assert_eq!(id.as_bytes(), &batch[at + 1..at + 21]);
            out.push((batch[at], id));
            at += 25 + len;
        }
    }
}

#[test]
fn copies_every_object_of_a_pack_but_the_skipped() {
    let secret = b"a purged file\n".to_vec();
    let kept = b"hello\n".to_vec();
    let (secret_id, kept_id) = (
        hash_object(ObjectKind::Blob, &secret),
        hash_object(ObjectKind::Blob, &kept),
    );
    let tree = encode_tree(&[
        TreeEntry {
            name: "a.txt".into(),
            mode: FileMode::Blob,
            id: kept_id,
        },
        TreeEntry {
            name: "key.txt".into(),
            mode: FileMode::Blob,
            id: secret_id,
        },
    ])
    .unwrap();
    let tree_id = hash_object(ObjectKind::Tree, &tree);
    let who = "Tester <t@example.com> 1700000000 +0000";
    let commit =
        format!("tree {tree_id}\nauthor {who}\ncommitter {who}\n\nimported\n").into_bytes();
    let commit_id = hash_object(ObjectKind::Commit, &commit);
    let objects = [
        (ObjectKind::Blob, &secret),
        (ObjectKind::Blob, &kept),
        (ObjectKind::Tree, &tree),
        (ObjectKind::Commit, &commit),
    ];
    let (mut writer, mut pack) = PackWriter::new(objects.len() as u32);
    for (kind, data) in objects {
        pack.extend(writer.entry(kind, data));
    }
    pack.extend_from_slice(&writer.finish());
    let zero = "0".repeat(40);
    let mut body = pkt(&format!(
        "{zero} {commit_id} refs/yoneda/copy\0report-status\n"
    ));
    body.extend_from_slice(b"0000");
    body.extend_from_slice(&pack);

    let mut session = ReceiveSession::new();
    for chunk in body.chunks(7) {
        session.feed(chunk).expect("feed");
    }
    session.finish().expect("finish");
    let copied = session
        .copy(&json!({ "skip": [secret_id.hex()] }))
        .expect("copy");
    assert_eq!(copied["objects"], 3);
    assert_eq!(
        frames(&mut session),
        vec![(1, commit_id), (2, tree_id), (3, kept_id)]
    );
    // Copied again with nothing skipped: every object.
    session.copy(&json!({})).expect("copy");
    assert_eq!(frames(&mut session).len(), 4);
    assert!(session.copy(&json!({ "skip": ["not-an-id"] })).is_err());
}
