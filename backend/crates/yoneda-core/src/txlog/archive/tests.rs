use super::*;
use crate::txlog::{TxKind, chain_digest};

fn oid(n: u8) -> ObjectId {
    ObjectId::from_bytes([n; 20])
}

/// `count` entries after `base`, alternating main between two commits.
fn run(base: &Checkpoint, count: u64) -> Vec<TxEntry> {
    let mut prev = base.chain.clone();
    let mut head = base.refs.get("refs/heads/main").copied();
    (base.version + 1..=base.version + count)
        .map(|version| {
            let new = oid(if version % 2 == 0 { 2 } else { 1 });
            let mut e = TxEntry {
                version,
                base_version: version - 1,
                kind: TxKind::RefMove,
                refname: "refs/heads/main".into(),
                old: head,
                new: Some(new),
                paths: vec![],
                read_set: vec![],
                actor: "user:owner".into(),
                intent_digest: "i".into(),
                committed_at_ms: version as i64,
                checkpoint_refs: None,
                chain: String::new(),
            };
            e.chain = chain_digest(&prev, &e).unwrap();
            prev = e.chain.clone();
            head = Some(new);
            e
        })
        .collect()
}

#[test]
fn sealed_segments_open_only_with_their_digest_and_replay_to_any_version() {
    let base = Checkpoint::default();
    let entries = run(&base, 8);
    let segment = Segment::seal(0, 8, entries.clone()).unwrap();
    let checkpoints = SegmentCheckpoints::seal(0, 8, base, vec![]).unwrap();
    assert_eq!(
        segment.key,
        "_log/segment-00000000000000000000-00000000000000000008.json"
    );
    assert_eq!(checkpoints.key, "_log/checkpoint-00000000000000000000.json");

    let opened = Segment::open(&segment.body, &segment.digest, 0, 8).unwrap();
    let cps = SegmentCheckpoints::open(&checkpoints.body, &checkpoints.digest, 0, 8).unwrap();
    assert_eq!(opened.last_chain(), entries[7].chain);
    let at5 = state_at(&opened, &cps, 5, &BTreeMap::new()).unwrap();
    assert_eq!((at5.version, at5.refs["refs/heads/main"]), (5, oid(1)));

    // One flipped byte (still valid JSON) and a re-sealed forgery are both refused.
    let flipped = segment.body.replacen("\"version\":5", "\"version\":6", 1);
    assert_eq!(
        Segment::open(&flipped, &segment.digest, 0, 8)
            .unwrap_err()
            .code,
        "ARCHIVE_CORRUPT"
    );
    assert_eq!(
        Segment::open("{", &segment.digest, 0, 8).unwrap_err().code,
        "ARCHIVE_CORRUPT"
    );
    let forged = Segment::seal(0, 7, entries[..7].to_vec()).unwrap();
    assert_eq!(
        Segment::open(&forged.body, &segment.digest, 0, 8)
            .unwrap_err()
            .code,
        "ARCHIVE_CORRUPT"
    );
    // A segment for other versions, even correctly sealed, does not answer for these.
    assert_eq!(
        Segment::open(&forged.body, &forged.digest, 0, 8)
            .unwrap_err()
            .code,
        "ARCHIVE_CORRUPT"
    );
}

#[test]
fn a_gap_or_reordered_run_cannot_be_sealed() {
    let mut entries = run(&Checkpoint::default(), 4);
    entries.swap(1, 2);
    assert_eq!(
        Segment::seal(0, 4, entries).unwrap_err().code,
        "ARCHIVE_CORRUPT"
    );
    assert!(Segment::seal(0, 5, run(&Checkpoint::default(), 4)).is_err());
}

#[test]
fn replay_starts_at_a_stored_checkpoint_only_when_it_verifies() {
    let base = Checkpoint::default();
    let mut entries = run(&base, 8);
    let at4 = replay_projected(&base, &entries[..4], &BTreeMap::new()).unwrap();
    let digest = at4.refs_digest().unwrap();
    // The entry after a stored checkpoint records its digest (rechained from there on).
    entries[4].checkpoint_refs = Some(digest.clone());
    let mut prev = entries[3].chain.clone();
    for e in &mut entries[4..] {
        e.chain = chain_digest(&prev, e).unwrap();
        prev = e.chain.clone();
    }
    let stored = vec![StoredCheckpoint {
        checkpoint: at4.clone(),
        refs_digest: Some(digest),
    }];
    let seg = Segment::open(
        &Segment::seal(0, 8, entries.clone()).unwrap().body,
        &Segment::seal(0, 8, entries.clone()).unwrap().digest,
        0,
        8,
    )
    .unwrap();
    let sealed = SegmentCheckpoints::seal(0, 8, base.clone(), stored).unwrap();
    let cps = SegmentCheckpoints::open(&sealed.body, &sealed.digest, 0, 8).unwrap();
    assert_eq!(
        state_at(&seg, &cps, 7, &BTreeMap::new()).unwrap().version,
        7
    );

    // A stored checkpoint whose refs were altered (and re-sealed) is refused by its digest.
    let mut altered = at4;
    altered.refs.insert("refs/heads/main".into(), oid(9));
    let bad = vec![StoredCheckpoint {
        checkpoint: altered,
        refs_digest: Some(cps.stored[0].refs_digest.clone().unwrap()),
    }];
    let resealed = SegmentCheckpoints::seal(0, 8, base, bad).unwrap();
    let cps = SegmentCheckpoints::open(&resealed.body, &resealed.digest, 0, 8).unwrap();
    assert_eq!(
        state_at(&seg, &cps, 7, &BTreeMap::new()).unwrap_err().code,
        "TXLOG_INVALID"
    );
}
