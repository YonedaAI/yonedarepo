//! Typed commit headers and timezone offsets: every decoded commit re-encodes to its
//! exact bytes, and hostile headers are refused or kept verbatim, never rewritten.
use super::*;
use crate::git_object::TzOffset;

const TREE: &str = "17358b7c8806c41cd6e2fd717cac03703a8d242b";
const PARENT: &str = "9cc640ed68a9dfd89fbcc3275ba1ba846b31ecdb";
const WHO: &str = "Bo <bo@example.com> 1 +0000";

fn raw(extra: &str) -> String {
    format!("tree {TREE}\nparent {PARENT}\nauthor {WHO}\ncommitter {WHO}\n{extra}\nmsg\n")
}

fn round_trip(bytes: &[u8]) -> Commit {
    let commit = Commit::decode(bytes).unwrap();
    assert_eq!(commit.encode(), bytes);
    commit
}

#[test]
fn offsets_parse_and_encode_exactly_as_written() {
    for text in ["+0000", "-0000", "-0700", "+0130", "+1400", "+9999"] {
        let offset = TzOffset::parse(text).unwrap();
        assert_eq!(offset.to_string(), text);
        assert_eq!(text.parse::<TzOffset>().unwrap(), offset);
    }
    assert_ne!(TzOffset::parse("-0000").unwrap(), TzOffset::UTC);
    assert_eq!(TzOffset::UTC.to_string(), "+0000");
    for text in [
        "",
        "0100",
        "+100",
        "+01000",
        "+01a0",
        "+01:0",
        " +0100",
        "+0100 ",
        "*0100",
        "＋0100",
        "+٠١٠٠",
    ] {
        let error = TzOffset::parse(text).unwrap_err();
        assert_eq!(
            error.message, "Signature offset must look like +hhmm",
            "{text:?}"
        );
    }
}

#[test]
fn offsets_serialize_as_the_same_string() {
    let offset = TzOffset::parse("-0700").unwrap();
    assert_eq!(serde_json::to_value(offset).unwrap(), "-0700");
    assert_eq!(
        serde_json::from_value::<TzOffset>("+0130".into()).unwrap(),
        TzOffset::parse("+0130").unwrap()
    );
    assert!(serde_json::from_value::<TzOffset>("0130".into()).is_err());
    assert!(serde_json::from_value::<TzOffset>(130.into()).is_err());
}

#[test]
fn signatures_keep_negative_zero_and_reject_bad_offsets() {
    let text = raw("").replace(&format!("committer {WHO}"), "committer Bo <b> 1 -0000");
    let commit = round_trip(text.as_bytes());
    assert_eq!(commit.committer().unwrap().offset.to_string(), "-0000");
    for bad in ["+000", "0000", "+00:0"] {
        let text = raw("").replace("1 +0000\ncommitter", &format!("1 {bad}\ncommitter"));
        assert!(Commit::decode(text.as_bytes()).is_err(), "{bad}");
    }
}

#[test]
fn known_headers_decode_to_their_git_kinds_in_order() {
    let text = raw(
        // A blank continuation line is a lone space, so the header block holds no "\n\n".
        "encoding ISO-8859-1\nmergetag object a\n type commit\n \nx-custom one\n two\n\
         gpgsig -----BEGIN-----\n line two\n -----END-----\ngpgsig-sha256 sig256\n",
    );
    let commit = round_trip(text.as_bytes());
    let tree = ObjectId::parse(TREE).unwrap();
    let parent = ObjectId::parse(PARENT).unwrap();
    assert_eq!(
        commit.headers(),
        [
            CommitHeader::Tree(tree),
            CommitHeader::Parent(parent),
            CommitHeader::Author(WHO.into()),
            CommitHeader::Committer(WHO.into()),
            CommitHeader::Encoding("ISO-8859-1".into()),
            CommitHeader::Mergetag(b"object a\ntype commit\n".to_vec()),
            CommitHeader::Other("x-custom".into(), b"one\ntwo".to_vec()),
            CommitHeader::Gpgsig(b"-----BEGIN-----\nline two\n-----END-----".to_vec()),
            CommitHeader::GpgsigSha256(b"sig256".to_vec()),
        ]
    );
    assert_eq!(commit.message(), b"msg\n");
}

/// `raw("")` with `extra` header bytes after the committer.
fn with_extra(extra: &[u8]) -> Vec<u8> {
    let mut text = raw("").into_bytes();
    let at = text.len() - b"\nmsg\n".len();
    text.splice(at..at, extra.iter().copied());
    text
}

#[test]
fn headers_git_tolerates_survive_byte_for_byte() {
    for extra in [
        &b"encoding \xff\xfe\n"[..],
        b"encoding a\nencoding b\n",
        b"gpgsig \n",
        b"tree not-an-id\n",
        b"x \xff\n",
    ] {
        let commit = round_trip(&with_extra(extra));
        assert_eq!(commit.tree().unwrap().hex(), TREE);
    }
    // An encoding that is not UTF-8 is kept verbatim as an unrecognised header, not refused.
    let commit = round_trip(&with_extra(b"encoding \xff\n"));
    assert_eq!(
        commit.headers()[4],
        CommitHeader::Other("encoding".into(), b"\xff".to_vec())
    );
    // A zero-padded time is not canonical, but Git writes it and the id is the bytes.
    let padded = raw("").replace(
        "author Bo <bo@example.com> 1",
        "author Bo <bo@example.com> 01",
    );
    round_trip(padded.as_bytes());
}

#[test]
fn hostile_headers_are_refused() {
    let author = format!("author {WHO}\n");
    let committer = format!("committer {WHO}\n");
    for bad in [
        raw(&author),
        raw(&committer),
        raw("").replace(&author, ""),
        raw("").replace(&format!("tree {TREE}\n"), ""),
        format!("parent {PARENT}\ntree {TREE}\n{author}{committer}\nmsg\n"),
        raw("").replace(
            &format!("tree {TREE}"),
            &format!("tree {}", TREE.to_uppercase()),
        ),
        raw("").replace(&format!("parent {PARENT}"), "parent zz"),
        raw("novalue\n"),
        format!(" leading continuation\n{}", raw("")),
        raw("").replace("author Bo", "author B\u{0}o"),
        raw("").replace(&format!("committer {WHO}\n"), "committer \u{fffd}\n"),
        "no header terminator".into(),
    ] {
        assert!(Commit::decode(bad.as_bytes()).is_err(), "{bad:?}");
    }
    let mut not_utf8_key = raw("").into_bytes();
    not_utf8_key.splice(0..0, b"\xff key\n".iter().copied());
    assert!(Commit::decode(&not_utf8_key).is_err());
    let mut not_utf8_author = raw("").into_bytes();
    let at = not_utf8_author
        .windows(3)
        .position(|w| w == b"Bo ")
        .unwrap();
    not_utf8_author[at] = 0xff;
    assert!(Commit::decode(&not_utf8_author).is_err());
}

#[test]
fn new_commits_carry_only_the_four_typed_identity_headers() {
    let who = Signature {
        name: "Bo".into(),
        email: "bo@example.com".into(),
        seconds: 1,
        offset: TzOffset::UTC,
    };
    let tree = ObjectId::parse(TREE).unwrap();
    let commit = Commit::new(tree, &[], &who, &who, "msg").unwrap();
    assert_eq!(
        commit.headers(),
        [
            CommitHeader::Tree(tree),
            CommitHeader::Author(WHO.into()),
            CommitHeader::Committer(WHO.into()),
        ]
    );
    assert_eq!(
        commit.encode(),
        format!("tree {TREE}\nauthor {WHO}\ncommitter {WHO}\n\nmsg\n").as_bytes()
    );
}
