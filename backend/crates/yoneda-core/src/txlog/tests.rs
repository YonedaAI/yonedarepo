use super::*;
use crate::git_object::ObjectId;
use std::collections::BTreeSet;

fn oid(n: u8) -> ObjectId {
    ObjectId::from_bytes([n; 20])
}
fn touch(path: &str) -> PathTouch {
    PathTouch {
        path: path.into(),
        op: PathOp::Modify,
        old_blob: Some(oid(1)),
        new_blob: Some(oid(2)),
        mode: None,
    }
}
fn entry(
    prev: &str,
    version: u64,
    old: Option<u8>,
    new: u8,
    paths: &[&str],
    reads: &[&str],
) -> TxEntry {
    let mut e = TxEntry {
        version,
        base_version: version - 1,
        kind: TxKind::Commit,
        refname: "refs/heads/main".into(),
        old: old.map(oid),
        new: Some(oid(new)),
        paths: paths.iter().map(|p| touch(p)).collect(),
        read_set: reads.iter().map(|r| r.to_string()).collect(),
        actor: "attempt:a".into(),
        intent_digest: "i".into(),
        committed_at_ms: version as i64,
        checkpoint_refs: None,
        chain: String::new(),
    };
    e.chain = chain_digest(prev, &e).unwrap();
    e
}
fn log() -> Vec<TxEntry> {
    let e1 = entry("", 1, None, 10, &["README.md"], &[]);
    let e2 = entry(
        &e1.chain,
        2,
        Some(10),
        11,
        &["src/auth/login.rs"],
        &["src/auth/"],
    );
    let e3 = entry(&e2.chain, 3, Some(11), 12, &["web/app.tsx"], &["web/"]);
    vec![e1, e2, e3]
}
fn none() -> Refinements {
    Refinements::new()
}
fn set(items: &[&str]) -> BTreeSet<String> {
    items.iter().map(|s| s.to_string()).collect()
}
fn proposal(writes: &[&str], reads: &[&str]) -> Proposal {
    Proposal {
        refname: "refs/heads/main".into(),
        base_version: 1,
        expected_old: Some(oid(10)),
        write_set: set(writes),
        read_set: set(reads),
    }
}

#[test]
fn replay_rebuilds_refs_and_verifies_the_chain() {
    let entries = log();
    let state = replay(&Checkpoint::default(), &entries).unwrap();
    assert_eq!(state.version, 3);
    assert_eq!(state.refs["refs/heads/main"], oid(12));
    // Checkpoint at 2 + tail equals full replay.
    let mid = replay(&Checkpoint::default(), &entries[..2]).unwrap();
    assert_eq!(replay(&mid, &entries[2..]).unwrap(), state);
    let mut tampered = entries.clone();
    tampered[1].paths[0].path = "src/other.rs".into();
    assert!(replay(&Checkpoint::default(), &tampered).is_err());
    assert!(
        replay(&Checkpoint::default(), &entries[1..]).is_err(),
        "gap must fail"
    );
    let mut stale = entries.clone();
    stale[2] = entry(&entries[1].chain, 3, Some(10), 12, &["x"], &[]);
    assert!(
        replay(&Checkpoint::default(), &stale).is_err(),
        "wrong old value must fail"
    );
}

#[test]
fn checkpoints_verify_their_ref_map_against_the_stored_and_logged_digest() {
    let entries = log();
    let mid = replay(&Checkpoint::default(), &entries[..2]).unwrap();
    let digest = mid.refs_digest().unwrap();
    let mut next = entry(&mid.chain, 3, Some(11), 12, &["web/app.tsx"], &[]);
    next.checkpoint_refs = Some(digest.clone());
    next.chain = chain_digest(&mid.chain, &next).unwrap();
    mid.verify(&digest, None).unwrap();
    mid.verify(&digest, Some(&next)).unwrap();
    // One ref altered while the chain digest and the stored digest are kept.
    let mut altered = mid.clone();
    altered.refs.insert("refs/heads/main".into(), oid(99));
    assert_eq!(
        altered.verify(&digest, None).unwrap_err().code,
        "TXLOG_INVALID"
    );
    // Rewriting the stored digest too is caught by the digest the next entry carries.
    let forged = altered.refs_digest().unwrap();
    assert!(altered.verify(&forged, Some(&next)).is_err());
    // An entry written before digests existed does not vouch for a checkpoint.
    assert!(mid.verify(&digest, Some(&entries[2])).is_err());
}

#[test]
fn independent_writes_rebase_and_overlaps_conflict() {
    let later = &log()[1..];
    assert_eq!(
        proposal(&["docs/guide.md"], &["docs/"]).check(&[], &none()),
        OccOutcome::FastForward
    );
    assert_eq!(
        proposal(&["docs/guide.md"], &["docs/"]).check(later, &none()),
        OccOutcome::Rebase {
            concurrent: vec![2, 3]
        }
    );
    // Write/write on the same file: a three-way merge decides.
    assert_eq!(
        proposal(&["web/app.tsx"], &[]).check(later, &none()),
        OccOutcome::Merge {
            concurrent: vec![2, 3],
            paths: vec!["web/app.tsx".into()]
        }
    );
    // They read a directory I write: they serialize before me, so this is independent.
    assert_eq!(
        proposal(&["src/auth/session.rs"], &[]).check(later, &none()),
        OccOutcome::Rebase {
            concurrent: vec![2, 3]
        }
    );
    // They wrote something I declared as read.
    match proposal(&["docs/a.md"], &["src/"]).check(later, &none()) {
        OccOutcome::Conflict { version, paths } => {
            assert_eq!(version, 2);
            assert_eq!(paths, vec!["src/".to_string()]);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn opaque_ref_moves_are_never_assumed_independent() {
    let mut later = log()[1..2].to_vec();
    later[0].kind = TxKind::RefMove;
    later[0].paths.clear();
    assert!(matches!(
        proposal(&["docs/a.md"], &[]).check(&later, &none()),
        OccOutcome::Conflict { .. }
    ));
}

#[test]
fn path_overlap_respects_component_boundaries() {
    assert!(overlaps("src/a.rs", "src/a.rs"));
    assert!(overlaps("src/", "src/a.rs"));
    assert!(overlaps("src", "src/a.rs"));
    assert!(!overlaps("src", "src2/a.rs"));
    assert!(!overlaps("src/a.rs", "src/a.rsx"));
}

#[test]
fn symbol_reads_conflict_only_with_writes_to_that_symbol() {
    let e1 = entry("", 1, None, 10, &["README.md"], &[]);
    let e2 = entry(&e1.chain, 2, Some(10), 11, &["src/lib.rs"], &[]);
    let later = vec![e2];
    let refined: Refinements = [(
        2,
        vec![SymbolTouch {
            path: "src/lib.rs".into(),
            symbols: vec!["retry".into()],
        }],
    )]
    .into();
    // Reading another symbol of the same file: a same-file merge, not a stale read.
    assert_eq!(
        proposal(&["src/lib.rs"], &["src/lib.rs#backoff"]).check(&later, &refined),
        OccOutcome::Merge {
            concurrent: vec![2],
            paths: vec!["src/lib.rs".into()]
        }
    );
    assert_eq!(
        proposal(&["docs/a.md"], &["src/lib.rs#retry"]).check(&later, &refined),
        OccOutcome::Conflict {
            version: 2,
            paths: vec!["src/lib.rs#retry".into()]
        }
    );
    // Without a derived refinement the write is the whole file.
    assert!(matches!(
        proposal(&["docs/a.md"], &["src/lib.rs#backoff"]).check(&later, &none()),
        OccOutcome::Conflict { .. }
    ));
    // Path-level readers always see the write.
    assert!(matches!(
        proposal(&["docs/a.md"], &["src/lib.rs"]).check(&later, &refined),
        OccOutcome::Conflict { .. }
    ));
}
